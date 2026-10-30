# 069: A box has a page of its own, and the Boxes page says how each box is now

Status: accepted, 29 October 2026, with the owner's answer to each open question (each default); revised the same day after two
independent reviews (see [What changed after the reviews](#what-changed-after-the-reviews)),
and settled after their re-reviews, each remaining point as a rule owned by
one build unit (see [Gated in unit N](#gated-in-unit-n) and [What changed
after the re-reviews](#what-changed-after-the-re-reviews)).
Being built in the units of [How it is built](#14-how-it-is-built).

The prototype is [069-boxes-page/prototype.html](069-boxes-page/prototype.html):
one file, opened in any browser, made from bb-box's own components with a
fake server. Its source is in [069-boxes-page/prototype](069-boxes-page/prototype/).
How to click through it is under [The prototype](#the-prototype).

## Context

The owner, on the Boxes page in production, after looking at boat.dev's
dashboard: "How can we improve our boxes page to be nice? I don't want it
to be like boat.dev, obviously, because boat.dev is optimized for listing
your sandboxes or VMs."

Then, on boat.dev's page for one sandbox (a header with the name and IDs;
an action bar of Copy SSH, Desktop, Browser, Stop, Fork and Delete; a grid
of facts; CPU, RAM, disk and IO now and as a chart over 1 hour, 24 hours or
a week; the top processes by CPU): "Something like this page. When you
click on it, we should have something like this too in the Boxes page. We
already have all this info, on the sidebar with the Monitor stuff; we
should just put it in and create something." Pointing at a box's row,
whose click today only unfolds a few facts: "Over here." And: "How do we
improve this whole page? It's good now, but a little bit more
improvement."

The Boxes page is bb-box's `navPanel` (`BoxesPage` and `BoxList` in
`src/app/desktop.tsx`, rows in `src/app/box-row.tsx` and
`src/app/settings-machines.tsx`, the toolbar in `src/app/boxes-toolbar.tsx`).
It lists every box across threads and the person's own machines (036), on
two tabs, Machines and Threads, with search, filters and sort. A box's
desktop, device or terminal opens on the page at
`<threadId>/<boxId>[/device|/terminal]`, with a way back; from settings,
the same path ends in `/from-settings` and its way back goes to settings.

The Monitor (066, `src/app/monitor`, `src/plugin/monitor.ts`) reads any
machine it can: BB's server, the person's machines, and each box, through
bb-box's host entry where the box is a BB machine and through the box's
command route where it is not. A box is a machine there, with its `boxId`.

### Who uses the page, and for what

One person uses it: the operator of a BB install, today the owner, every
day. Agents do not use it; they use `box_list`, `box_status` and the other
box tools. The tasks, most frequent first. The order is estimated from the
owner's notes and the decisions' history, not measured.

| # | Task | How often |
| --- | --- | --- |
| 1 | Open a box's desktop, device or terminal, to watch the agent or take over | Several times a day |
| 2 | See how a thread's box is doing now: is it busy, is that why the thread is slow | Daily |
| 3 | Find the boxes that can go: forgotten, stopped for days, failed | Weekly |
| 4 | Stop, start, resize or release a box | Weekly |
| 5 | Reach a box from outside: its address, its ID for a command | Weekly |
| 6 | Understand a box that did not start, or started slowly | When it happens |
| 7 | Add, start, stop or remove one of their own machines | Rarely |

### What is good today

- One place for every box, across threads, with the person's own
  machines on a tab of their own.
- Each thread's boxes sit under the thread's title, which opens the
  thread.
- Rows are short and calm, one line for what the box is and one for its
  state, in the look of BB's Automations page.
- Quick actions open a box's views, and Stop or Start it in one click; the
  menu has everything else. A stop or release asks first when a thread is
  working on the box's BB machine (`guarded` in `src/plugin/rpc.ts`, which
  reads `threadsOn`). It does not ask when the box's own thread is working
  through box tools, which is the usual case.
- A row shows the box's error, an unrequested stop, a failed join to BB
  and a resize's result under its status line.
- Search, filters with counts, sort, and a tab that is remembered.
- A view opens on the page with a way back, or in a browser tab of its own.

### What is wrong today

Looked at in the owner's browser on 29 October 2026, looking only, in a
window of 1,601 by 1,052 px, with 6 threads holding 9 or more boxes and 2
machines of the owner's own. Names here are generic.

1. A click unfolds the row into 7 or more facts in small type. The timings
   are one line of 9 parts ("warm 0.3 s · clone 1.1 s · configure 24 ms ·
   tags 18 ms · start 1.3 s · network 0.3 s · ssh 0.2 s · total 3.6 s · BB
   enrolment 2.4 s"). There is no link to a box: a reload closes it, and
   nothing can be sent to someone or opened in another tab.
2. Rows say how a box started, not how it is. Every row seen begins with
   how long the box took to be ready and to join BB, such as "Ready in
   3.6 s · BB machine in 2.4 s". None says how long it has been up, that
   it has been stopped for a day, or that it is at 96% CPU.
3. "8 cores · 16 GiB · 16 GiB": memory and disk read alike.
4. A box's numbers are elsewhere: in the Monitor, in BB's sidebar footer,
   picked by name from a list of every machine. They cover the last 6
   minutes (72 readings), and only while the Monitor is open on that box.
   Nothing remembers how a box was an hour ago.
5. The Threads tab does not say whether a thread is working. The Machines
   tab does, with a spinner on each working thread's chip.
6. The code adds "The agent has control" to every ready desktop row on
   the Threads tab (`BoxList` in `src/app/desktop.tsx`), which is the
   normal case. Only a person's control is news.

### What bb-box knows today, and what it does not

The Monitor's `monitor.machine` returns a snapshot (`src/monitor/snapshot.ts`):
CPU with cores, load or, in a container, pressure; memory with used,
available and pressure; one disk; one network interface with rates; GPU
and battery where there are sensors; the Tailscale name and addresses; the
top 6 processes by name, PID, CPU and memory; health with its issues; and
the last 72 readings of CPU, memory and network. A shared slot's reading
adds its host and the Mac's encoder room. In a slot, the processes are its
own user's, but CPU, memory, disk and network are the whole Mac's.

It keeps no history. Each machine's readings are held by a sampler that
forgets its counters 15 s, or two refresh intervals, after the last reader
goes. A reading after that starts cold: it takes a baseline, waits 300 ms
and reads again, so it measures 300 ms, not the time since the last
reading. A cold route reading runs its script twice. Each reading is a
full one: every process, `tailscale status`, the disk and, on a Mac, the
battery and sensors. Disk I/O is not read.

A box's record (`BoxRecord`, kept in BB's key-value store under
`box/<threadId>/<boxId>`, with an index from box ID to thread) holds the
latest `stoppedAt`, the first `readyAt` and the latest stop bb-box did not
ask for. It does not hold earlier stops, who asked for a stop, when the
last start was asked for or finished (a start does not update `readyAt`),
or anything about a box once it is released. A release that fails leaves
the record in `releasing` with an error.

Decision 066 said the owner wanted "no monitoring on the box page". That
was the Box panel in a thread, and it stays so. This decision puts the
Monitor's numbers on the Boxes page, as the owner now asks.

### What BB lets a plugin do here

A `navPanel` owns a route and its sub-paths. The Boxes page already uses
them: `/plugins/bb-box/desktop/<threadId>/<boxId>` opens a desktop, survives
a reload, and is what Open in browser gives. So a box's page can have a
real path, unlike the settings page, which had only the URL's hash (067).

## Three directions for the box page

Three were sketched, each as a wide window.

**A. A report, one column (chosen).** How the box is now, then what it
is, top to bottom; its views open one step further in.

```
‹ Boxes › amber-fox
[□] amber-fox  Linux  Desktop  LXC          [Desktop] [Terminal] [Stop] [⋯]
    ● Ready · up 2 h 14 min
    bxamberfox2q7k ⧉   Copy link
For (◌ Fix the sign-in flow ↗) working now
┌ Activity                         [Live 1 h 24 h 7 d] ┐
│ CPU 31%  │ Memory 58%  │ Disk 19 GiB free │ Network │
│ ╱╲_╱‾╲__ chart, CPU and memory, busiest minutes     │
└─────────────────────────────────────────────────────┘
┌ Top processes ┐
┌ Kind ─────┬ Size ──────┬ Runs on ─────┬ Address ──┐
├ System ───┼ BB machine ┼ Made ────────┼ Desktop ──┤
┌ Other threads on it ┐ ┌ How it started ┐
```

**B. The screen first.** A still of the box's desktop or device leads the
page, as large as the page allows, with the numbers in a column beside it;
a click on the still opens the view. Rejected: the still is stale the
moment it is taken; taking one costs the box a capture each time the page
opens (on an iOS slot, through the device server); it repeats the view one
click away; and a box with no screen, most boxes, gets a page that looks
unfinished.

**C. A workspace.** The view sits in the page, with a rail of facts and
numbers beside it and tabs for Overview, Desktop and Terminal. Rejected: a
desktop wants every pixel (video at its own size, 060), and a rail takes
about 280 px of it; tabs hide the numbers while watching; and the glance
of task 2 becomes a heavier page.

From B, A keeps the view's buttons first among the actions. From C, it
keeps the numbers while watching: the view's bar shows the box's CPU and
memory now, and they lead back to its page.

## Decision

### 1. A box's page is one step in from its row, with a link of its own

| Path under `/plugins/bb-box/desktop/` | Shows |
| --- | --- |
| (none), `threads`, `machines` | The list, on the tab remembered, or the one named |
| `box/<boxId>` | The box's page |
| `box/<boxId>/desktop`, `/device`, `/terminal` | A view of the box |
| The same, ending in one or two origins: `from-list`, `from-box`, `from-settings` | Where it was opened from, innermost first, so the way back knows it after a reload: `box/<boxId>/from-settings`, `box/<boxId>/desktop/from-list`, `box/<boxId>/desktop/from-box/from-settings` |
| `<threadId>/<boxId>[/device\|/terminal][/from-settings]` | As today, so links and Open in browser tabs keep working |

A box ID (`bx` and 12 letters and digits) never names a thread, so the
page needs only it: the server finds the box through its existing index
from box ID to thread, or among the person's machines.

How it opens:

- A click anywhere on a row that is not one of its controls, or on the
  row's chevron, which is the same link.
- The row's name is a link: Tab reaches it, Enter opens the page, and
  Ctrl-click, Command-click or a middle click opens it in a new browser tab.
- From the Monitor's Open menu, a new first item, "Page", for a box.
- From the thread's Box panel, a new menu item, "Open on the Boxes page".
- From settings, wherever settings names a machine of the person's own,
  with `from-settings`.

The way back is where the person came from (gate G8, unit 1c):

- BB's `useBbNavigate().toPluginPanel(path, { subPath, replace })` takes a
  sub-path and nothing else (in SDK 0.6.49; unit 1c checks 0.6.15 before
  building), so an entry cannot carry state. Where an entry was opened from
  is the last part of its path, as `from-settings` already is. It survives
  a reload and a copied link.
- Every way into a page or a view adds its origin: a row's click, name,
  chevron, quick icons and menu items add `from-list`; the page's view
  buttons add `from-box`, keeping the page's own origin after it; settings
  adds `from-settings`, which a page passes on to the views it opens.
- The panel also remembers, in memory, the last move it made itself. When
  the way back leads to the entry that move came from, it goes back in
  history, so the browser's Back and the page's own way back agree and
  nothing is pushed twice. Otherwise (after a reload, in a new tab, from a
  link) it goes to the origin the path names, replacing the entry. With no
  origin in the path, a view's parent is the box's page and the page's is
  the list, also by replacing.
- `from-settings` always goes back to settings, from the page and from
  every view opened through it.

The list keeps its place (gate G9, unit 1d). Its search, filters, sort, tab
and scroll are kept for the browser tab's session outside the page's
components, as 067 keeps drafts. Every way out of a row, its quick icons
and menu included, records that row first. Returning by any way back, the
list shows them as they were, with focus on the name of that row, or on
the row now in its place if that box has gone. The search row and tabs
stay above the scrolling rows, as today.

On opening the box's page, it scrolls to the top and the box's name takes
focus, so Tab goes on to the actions and Shift-Tab reaches the trail.
Nothing slides or fades: the owner removed the settings page's slide, and
this page opens tens of times a day.

### 2. The header: what it is, how it is, what to do

- The box's glyph, its name (18 px, against a row's 13 px, tracked a
  little tighter), its system, its device's model, and the same badges as
  its row.
- One line for its state: the dot, a word, and what makes it news (table
  in [section 7](#7-each-state)). A busy box adds, in words, "Busy: CPU 96%
  for 9 min", which is a link to its processes.
- Its ID, copied with a click, and Copy link, which copies the page's
  address: what an agent or a bug report needs, without scrolling.
- Its thread: "For (thread title ↗) working now", or "idle for 3 h". The
  chip opens the thread, and spins while the thread works, as the
  Machines tab's chips do. One of the person's own machines says so
  instead: "One of your machines. It shows in BB's machine list, and
  threads can run on it."

The actions, right of the name on a wide window and under it on a narrow
one, in this order:

1. Its views, as outline buttons with their glyphs: Desktop, Simulator or
   Emulator, Terminal. One that cannot open now is disabled and says why
   ("silver-pine is stopped", "pve-3 does not answer").
2. Start, the one filled button, when it is stopped. Stop when it is
   ready. Both are disabled, with the reason, when bb-box cannot reach the
   box's backend.
3. The menu: Copy address, New thread on this box…, Resize…, Check now,
   then Release… (Remove… for a machine of the person's own; Release
   again… after a release that did not finish; Forget… when its backend is
   no longer in settings), with 061's resize dialog, today's in-use guard
   and today's confirmations.

Not offered, though boat.dev has them: Fork, Prompt, AI usage and cost.
bb-box has no fork of a box, and no price for one.

### 3. The page, in order

How the box is now comes before what it is, as task 2 comes before the
rest:

1. The header.
2. Notices, when there are any (section 7): a failed operation, a backend
   that is not in settings, a host that does not answer, a failed start, a
   stop bb-box did not ask for, a device that did not boot, a failed join
   to BB.
3. Starting, while the box starts: its steps so far.
4. Activity (section 4).
5. Top processes (section 5).
6. Facts: eight cells, four across on a wide window and two on a narrow
   one.

   | Cell | First line | Second line | From |
   | --- | --- | --- | --- |
   | Kind | Linux desktop | | `kindLabel` |
   | Size | 4 cores, 8 GiB memory, 32 GiB disk; "A share of mac-1 (12 cores, 32 GiB)" for a slot | | `sizeNow`, `size` |
   | Runs on | LXC container on pve-1 | Proxmox LXC, or "Backend not in settings" | `form`, `shared`, `backendLabel` |
   | Address | 10.20.0.31, copied with a click | Its tailnet name, where a reading has one | `address`, the snapshot's `tailscale` |
   | System | Linux x86_64, with Docker | | `os`, `arch`, `docker` |
   | BB machine | Joined | Threads can run on it; Offline now | `enrol` |
   | Made | 2 h 14 min ago | today at 4:44 PM | `createdAt` |
   | Desktop, Device or Resize | The agent has control; iPhone 17 Pro; "Disk now; cores and memory with a restart" | 1920 × 1080, video; iOS 26.1 · control: the agent | `control`, `device`, `facts`, `resizing` |

7. Other threads on it, and How it started, side by side.

### 4. Activity: the Monitor's numbers, now and over time

A card headed "Activity", with the time of the last reading ("Read at
6:58 PM"), and a range: Live, 1 h, 24 h, 7 d, as a radio group that the
arrow keys move through. It opens on Live for a box being read, and on
24 h otherwise.

- **Now**, while the box is read: four tiles, the Monitor's own sections
  in the page's width, with their pills and words: CPU with load, or
  pressure in a container; Memory with Normal, High or Critical; Disk free
  with its size; Network down and up. A GPU tile joins them where the
  reading has GPU numbers.
- **A shared slot** (an iOS or macOS user on a Mac shared with other
  slots) never shows the Mac's numbers as its own (gates G1, G2, unit 2).
  Its tiles are "This slot's CPU" and "This slot's memory", from its own
  user's processes and their exited children, against its share of the
  Mac: "40% of its share (1.6 of its 4 cores, of mac-1's 12)", "1.5 GiB of
  its 10.7 GiB",
  then "mac-1, all slots" (the Mac's CPU, host load and memory, marked
  busy when it is), "mac-1's encoder" (its encoder room) and "mac-1's disk"
  (its free disk, with the slot's own files beside it). A line says so:
  "This slot is a macOS user on mac-1, shared with 2 other slots. Its CPU
  and memory are its own processes'. mac-1's numbers are every slot's
  together, and never make this slot busy." Its chart has the slot's CPU
  and memory, and "mac-1's CPU, all slots" as a third line, hidden at
  first.
- **The chart**: CPU, memory and disk (or the Mac's CPU, for a slot) as %
  used, on one scale from 0 to 100%. Each can be hidden with its legend
  chip; disk starts hidden, as it moves slowly. Over 24 h and 7 d, a light
  band above CPU's line is each step's busiest minute, so a short spike is
  not averaged away.
- **Network** below, down and up, on its own scale. Both charts have one
  plot width, so a time falls at the same place on each.
- **Times** are marked at whole steps: every 2 minutes on Live, every 15
  minutes over 1 h, every 6 hours over 24 h, and at each midnight over 7 d.
- **Gaps say why**, from the box log and the history (section 10): "Not
  made yet", "Starting", "Stopped", "Not read" (the Monitor or box history
  was off), "No reading" (a reading failed or was skipped). A few failed
  readings never show as Stopped.
- **Reading a point**: hovering, or the arrow keys once the chart has
  focus, shows the time and each value, with the busiest minute where it is
  5 points or more above the mean. Home and End go to the first and last
  point, Page Up and Page Down jump 10, Escape clears; none of them scrolls
  the page.

| Range | Points | Step | Source |
| --- | --- | --- | --- |
| Live | 72 | The Monitor's interval, 5 s by default | `monitor.machine`, as the Monitor reads today, while the page is shown |
| 1 h | 60 | 1 minute | Box history (section 10) |
| 24 h | 144 | 10 minutes | Box history |
| 7 d | 168 | 1 hour | Box history |

The page's Live reading and the Monitor's, on the same box, are one
reading through the Monitor's sampler.

When the Monitor is off, nothing is read and Live cannot be chosen, but
the history already kept stays on show, under one line: "The Monitor is
off, so bb-box reads nothing now. What it read before stays. Turn it on in
Monitor settings", the last words a link to the Monitor's page in settings
(067). When only box history is off, Live still reads while the page is
open, and 1 h, 24 h and 7 d keep what was read before, under "Box history
is off". A box bb-box can never read,
as a Windows box that is not a BB machine, says the Monitor's own words
instead of a chart. A Live reading that fails after one worked keeps the
last numbers under the Monitor's "Showing data from 6:58 PM" notice. While
a box is stopping, Live stays until its readings stop or the stop is
confirmed, then the card turns to 24 h (gate G16, unit 2). The network
chart, like CPU's, is described by its numbers: "Over the last 24 hours:
download averaged 820 KB/s, highest 2.1 MB/s at 4:10 PM; upload averaged
96 KB/s", with any gaps (gate G17, unit 2).

### 5. Top processes

Under Activity, while the box is read: the Monitor's top 6 by CPU, as a
table of name, PID, CPU and memory, by name only, never arguments or
environment (066). For a slot, "This slot's processes", its own user's
only. A note says CPU is per core, so a build on four cores shows 400%;
values of 100% or more are amber, with the number. Below 640 px the PID
column goes, so the name keeps its room; a long name is cut in its middle,
keeping both ends, as the Monitor does.

### 6. Other threads, and how it started

- **Other threads on it**: the threads working on its BB machine besides
  its own, as the Machines tab's chips, with New thread on this box…; or
  why there are none ("Its BB machine is offline now"). For a machine of
  the person's own: "Threads on this machine".
- **How it started**: "Ready in 3.6 s", a bar of its steps in proportion
  (its steps also named in the bar's text for screen readers), the four
  longest steps by name with their times, then one line: how many quicker
  steps, when it joined BB, and when it was made. Step names are words a
  person uses: "Took a warm box", "Clone", "Network", "Join BB". After a
  restart, one more line: "Last started today at 6:58 PM, by you: ready in
  1.9 s (boot 1.4 s, SSH 0.5 s)", from the box log. This replaces the
  9-part line.

### 7. Each state

The box's state and the result of the last thing asked of it are kept
apart: a box can be ready and have a stop that failed. Each row of the
table is said in words beside its dot, never by colour alone. Where a time
or an actor is not in the box log (section 10), as for a box made before
it, the words leave it out rather than guess.

| State | Header | Body |
| --- | --- | --- |
| Ready | ● Ready · up 2 h 14 min, from the last start | As section 3 |
| Ready and busy | ● Ready · up 46 min · Busy: CPU 96% for 9 min | As ready; the busy words link to the processes |
| Starting, first time | ◌ Starting · for 6 s, from when it was asked for | A card of the steps done so far, each with its time, and what it waits on ("Waiting for the box to answer on SSH"). The page follows it: when it is ready, the rest appears in place |
| Starting again | ◌ Starting · for 2 s, from when Start was pressed | The same card with the start's own steps (boot, SSH), not the first acquisition's |
| Stopping | ◌ Stopping… | As ready: Live stays until it has stopped |
| Stopped | ○ Stopped · 3 h 5 min ago, today at 3:53 PM, by you | Facts with "None while stopped" and "Offline now", Activity on 24 h with its stops shown, no processes. Start is the filled button. "by you", "by the agent in (thread)", "by a bb box command", "by bb-box: (why)" or "outside bb-box", only as the box log has it |
| Stopped without being asked | ○ Stopped · … outside bb-box | Today's amber notice with what bb-box saw and did (#406), under the header |
| Stop, Start or Resize failed | The state bb-box last confirmed, with when | A red notice, "Stop failed 2 min ago", with the backend's words and what bb-box then observed: "It is still running (checked 6:58 PM)", or "bb-box could not confirm its state". A resize that failed part way names the parts that changed. Stop again, Start again or Resize… (gate G6) |
| Release did not finish | ● Release did not finish · 1 min ago | A red notice with the backend's words: "The box may still run on pve-1; bb-box keeps its record until a release is confirmed." Release again… in the notice and the menu. Never a spinner without end |
| Its backend is not in settings | ● Not checked · last seen ready 2 d ago | An amber notice: the backend was removed from settings, so bb-box cannot check, stop or release the box, which may still be running there. Open BB Box settings, to add it back, or Forget…, which removes bb-box's record only and says that a guest that still runs keeps running. Stop, Start, Resize and New thread on this box are disabled with that reason, in words beside them; Runs on is muted (gate G20) |
| Its backend does not answer | ● Not checked · last seen ready | Listing its backend's boxes fails (the sweep, every 3 minutes). An amber notice with the backend's error and since when: bb-box cannot check, stop, start or resize the box through it. Stop, Start, Resize and New thread on this box are disabled with that reason, in words (gate G20). It clears when the backend lists its boxes again |
| The box does not answer | ● Not answering · last seen ready 12 min ago | An amber notice with the box's error and since when: bb-box cannot reach it, so it cannot read it or run commands in it, but it can still stop, start or release it, as those go through its backend. "bb-box checks again in 4 min", from the reach check's schedule (section 10, gate G7), apart from the notice's words. Check now. Its views and New thread on this box are disabled with that reason; Stop, Start and Resize stay. The mark clears as soon as the box is seen stopped or answering. History shows "No reading" from then |
| A device that did not boot | ● Ready, with the device's words | An amber notice, "Its iPhone 17 Pro did not boot", with the device's error and Check now; Simulator opens the view, which shows the device's own state. A ready host never stands for a ready device |
| Could not join BB | ● Ready · Could not join BB | Today's join help (`JoinHelp`), as a notice |
| Failed | ● Failed · 52 min ago | A red notice, "It did not start", with the error, Check now and Release…; then how it started, up to where it stopped |
| Releasing | ◌ Releasing… | As it was, dimmed |
| Released, or a link to a box that is not there | | For 24 hours after a release, "amber-fox was released", with when, from the box log, across reloads and restarts. Otherwise "This box is not here. It may have been released more than 24 hours ago, or the link is wrong." Both with Back to boxes |
| Forgotten | | For 24 hours, "maple-row was forgotten: bb-box removed its record. Its box was not deleted and may still run on pve-old.", with when and who (gate G5). Never "released" |
| Gone (deleted outside bb-box) | ● Gone · deleted outside bb-box | Facts and How it started; Release… removes its record |

### 8. A view sits one step in from the page

A desktop, device or terminal opens at `box/<boxId>/<view>`, the whole
panel's width, as today: 060's viewer and the terminal, unchanged. Its bar
changes in three ways:

- Its back arrow goes back to where it was opened from, as its path names
  it (section 1), and says where: "Back to boxes" from a row,
  "Back to amber-fox" from the page or from a link with no origin, "Back to
  BB Box settings" from settings; the same after a reload. The box's name
  in the bar always opens its page.
- The box's other views are buttons in the bar, so Desktop to Terminal is
  one click. A switch replaces the view and keeps its origins in the path,
  so back still goes there.
- On a window wider than 640 px, the box's CPU and memory now, from the
  same reading as its page, sit before Take control. They lead to the page.

A view of a box that is not ready, or whose backend cannot be reached,
says why, with Start where it can.

### 9. The list

The page keeps its shape: the line under the title, Machines and Threads,
the gear and New box, search, filters and sort above the scrolling rows,
one card per thread. What changes:

- **A row says how the box is now.** Its second line is the state, what
  needs attention, how long, then its size in words that tell memory from
  disk. It may take two lines; what needs attention comes before the time
  and size, so a narrow row loses those first. Setup timings move to the
  box's page.

  | State | Second line |
  | --- | --- |
  | Ready | ● Ready · up 2 h · 4 cores · 8 GiB memory |
  | Busy | ● Ready · Busy: CPU 96% for 9 min · up 46 min · 8 cores · 16 GiB memory |
  | A person has control | ● Ready · You have control · up 2 h · 4 cores · 8 GiB memory |
  | A failed operation | ● Ready · Stop failed · up 2 h …, and the backend's words on the next line |
  | Its backend is not in settings | ● Last seen ready · Its backend is not in settings · 2 d ago |
  | Its host does not answer | ● Last seen ready · pve-3 does not answer · 12 min ago |
  | Joining BB, or could not | ● Ready · Could not join BB · up 12 s |
  | Starting | ◌ Starting · 7 s |
  | Stopped | ○ Stopped · 3 h ago · 4 cores · 8 GiB memory |
  | Failed | ● Failed · 52 min ago, and the error on the next two lines |

  The items that need attention, in this order: a failed operation, a
  backend not in settings, a host that does not answer, busy, a person's
  control, a failed join. Each is words, in amber or red, never colour
  alone. Today's lines under a row stay: the error, a stop bb-box did not
  ask for, a resize's result.

  "Busy" comes only from box history (section 10): the last 5 minute
  readings are 5 whole minutes in a row, each judged high by the
  Monitor's own rules for the same reason, and the newest is under 2
  minutes old. The words give that reason in the measure a person reads
  first ("Busy: CPU 96% for 9 min", "Busy: memory 93% for 6 min", "Disk
  97% full"). A container is judged by its pressure, as 066 says; only the
  words give its use. A box with its own kernel can also be busy by its
  five-minute load against its cores ("Busy: load 7.9 on 4 cores for 6
  min"). A slot is judged by its own processes only, against its share of
  the Mac ("Busy: 95% of its share for 7 min"). With history off, or with
  its newest point over 2 minutes old, no row and no page says busy (gate
  G15, unit 4).
- **A thread's title says whether it is working**: a spinner and
  "Working", or "Idle 3 h", as the chips on the Machines tab do.
- **A click opens the box's page.** The row's actions are its views'
  icons, Start for a stopped box, Stop for a ready one, the menu, and last
  the chevron, which opens the page too. Below 640 px, a row keeps its
  first view's icon, Start, the menu and the chevron; Stop is in the menu
  there, as today on a narrow row. Stop stays one click on a wide row,
  with no dialog of its own. The guard widens (gate G3, unit 1c): Stop and
  Release, from a row, the menu, the page or a notice's retry, ask first
  when the box's own thread is working, as they already do when a thread
  works on its BB machine: "Fix the sign-in flow in Safari is working on
  amber-fox. Stop it anyway?" When BB cannot say whether the thread works,
  they ask too ("bb-box could not ask BB whether …"). A resize that needs a
  restart asks under the same guard. A machine of the person's own keeps
  today's guard. The inline details go.
- **Sort by last active.** Sort gains "Last active": when the box's thread,
  or for a machine, any thread on it, last worked, or the box was last
  started, whichever is latest. Boxes nobody has used for days sort last,
  for task 3.
- **Hover** shades the row lightly, as a link; nothing moves.

Considered and left out, so the page stays a list and not a dashboard:
usage charts on rows, a summary of counts above the list, cost, and a
table with columns.

### 10. What the server adds

Five additions, each owned by one build unit (section 14), with its gates
in [Gated in unit N](#gated-in-unit-n).

#### How bb-box opens its two new files (unit 1b)

The plugin SDK gives bb-box one database, `bb.storage.database()`, the
file `<dataDir>/plugins/<id>/data.db`, with `bb.storage.migrate` recording
statements in its `_bb_migrations` table. The Monitor's store sets that
file's `max_page_count` to 10 MB, a cap on the whole file. bb-box has no
SQLite driver of its own at run time (`better-sqlite3` is a development
dependency), so the new files are opened through the SDK's handle (gate
G4):

- `ATTACH DATABASE '<folder of data.db>/box-log.db' AS boxlog` and
  `… box-history.db AS boxhistory`, on the handle, at start. Each attached
  file has its own write-ahead log, `journal_size_limit` and
  `max_page_count`: `boxlog` 8 MB, `boxhistory` 64 MB, each WAL 4 MB.
- Migrations for an attached file are kept in that file's own
  `_migrations` table, with the same rules as the SDK's (ordered
  statements, each with its hash, append-only), run in one transaction on
  attach.
- If the host's handle refuses `ATTACH`, the tables go in `data.db`
  instead, its cap rises from 10 MB to 48 MB, and each table has a row cap
  that keeps the box log under 4 MB and box history under 30 MB, so the
  Monitor's alerts always keep at least 10 MB. History stops writing
  before its cap, not at the file's.

#### The box log (unit 1b)

One table, `boxlog.box_events`: box ID, thread, time, kind, who, and words
of at most 1 KB.

- Kinds: made, ready, start asked, started, stop asked, stopped, stopped
  without being asked, resize asked, resized (with the parts that changed),
  release asked, released, forgotten, and a failed stop, start, resize or
  release with the backend's words.
- Who: the person (a call from bb-box's app), an agent (a box tool, with
  its thread), a command (`bb box`), bb-box itself (with why: spares,
  idle stops, a lapsed lease), or outside bb-box (a stop it did not ask
  for). Unknown stays unknown.
- **An operation's outcome is not the box's state** (gate G6). Each event
  of a failed operation carries what bb-box then observed of the box,
  when, and from where: after a failure bb-box observes the box, as
  `Boxes.#start` already does (`src/core/boxes.ts`), and the page's words
  come from that observation: "It is still running (checked 6:58 PM)", or
  "bb-box could not confirm its state". A resize that fails part way
  records the parts that did change. Only a confirmed stop makes a
  "Stopped" interval in history; a failed Start or Stop never does.
- **Release and forget are different events** (gate G5). "release asked"
  is written before the backend is called, and "released" only once the
  backend confirms; then the record goes. If bb-box restarts between the
  two, at start it finds the record in `releasing` with an open "release
  asked", observes the box, and either finishes the release (the guest is
  gone) or shows "Release did not finish". Forget writes "forgotten", with
  the box's name, ID, who, when and its last known backend and state; the
  record goes and nothing is deleted. The page then says "maple-row was
  forgotten: bb-box removed its record. Its box was not deleted and may
  still run on pve-old." Forgetting writes no "released" event and no
  stopped interval.
- **When the log cannot be written**, the action still runs, the page and
  its words claim nothing that the log would have said (no "by you", no
  "released"), and the doctor reports the failed write.
- Kept: for a box that exists, its last 7 days and the latest event of
  each kind; for a released or forgotten box, 24 hours after the event,
  which is the page's memory of it across reloads and restarts. Its
  history points go at the same time.
- The box's view gains what the page shows from it: the last start (asked,
  ready, by whom), the last stop (when, by whom), the last failed operation
  (which, when, the words, what was then observed), and its backend's
  reach (below).

#### A backend that is gone, or a host that does not answer (unit 1b)

A reach check in bb-box's server owns these words, whatever box history
does (gate G7).

- A backend is "not in settings" when the box's record names a backend the
  configuration no longer has. This is read from the configuration, at no
  cost, whenever it changes.
- A box is "not answering" when a command, a Live reading, a history
  reading or a view fails to reach it with a transport error. The reach
  check then retries that box alone: after 1 minute, after 5, then every
  15 minutes, until it answers. It tries the cheapest way first: for a BB
  machine, BB's own connection state, which costs nothing; for any other
  box, one command through its route with a 10 s timeout. It never calls a
  backend's API on its own: a power check through Proxmox, Namespace,
  Hetzner or boat.dev runs only on Check now, at most once a minute for a
  box. With 10 boxes not answering, that is at most 40 commands an hour
  after the first 20 minutes, and no paid API calls.
- The reach check runs the same with box history on or off, and with the
  Monitor off; it reads no numbers.
- The page's words follow it: "pve-3 does not answer. bb-box checks again
  in 4 min", with when it last answered.

#### `boxPage` (unit 1c)

One box by ID, for any owner, with what the page needs in one answer: the
box's view, its thread and whether that thread works (as `ThreadOnBox`),
the threads on its BB machine, its Monitor machine ID or why the Monitor
cannot read it, and, for a box released or forgotten in the last 24 hours,
its name, thread, which of the two, and when. The `changed` signal for the
box's thread or `operator` refreshes it.

#### Box history: what is read, and how (unit 3)

A reader in bb-box's server, `src/monitor/box-history.ts`. It does not
share readings with the Monitor's live sampler: a box whose page or
Monitor is open is read by both, and unit 3 measures that extra cost.

- **Light readings.** One reading of a box is:
  - CPU time: `/proc/stat`, or in a namespaced cgroup `cpu.stat`'s
    `usage_usec`;
  - memory: `meminfo`, or the cgroup's `memory.current` less
    `inactive_file`;
  - the inputs of 066's capacity and memory limits: `cpu.max`,
    `cpuset.cpus.effective`, the CPUs visible, `memory.max` and
    `MemTotal`;
  - CPU and memory pressure where the cgroup has them;
  - `/proc/loadavg`, for a box with its own kernel;
  - `df -P /`, and the network bytes of its default interface.

  No process list, no Tailscale, no sensors or battery. For a box read
  through its command route this is one command whose answer is under
  1 KB; for a BB machine, one call to a new `monitor.light` handler in
  bb-box's host entry.
- **066's limits, reused** (gate G10). A container's CPU percentage is its
  CPU time against `containerCapacity` (the least of its quota, its cpuset
  and the CPUs it can see), and its memory against `containerMemory` (the
  least of a finite `memory.max` and the memory it can see), both from
  `src/monitor/container.ts`, unchanged. On Proxmox LXC, where the limits
  sit on the parent cgroup, `cpu.max` reads `max 100000` and `memory.max`
  reads `max`, so the cpuset and LXCFS's `MemTotal` are what limit a box;
  Astra's re-review read exactly that on a 2-core, 4 GiB box.
- **Counters kept between readings** (gate G12). The reader keeps each
  box's last cumulative counters and when they were read, in memory and in
  the history file, so each point is the mean over the time since the
  last reading, not a 300 ms sample, and records the start and end of the
  time it covers. Counters older than 150 s (2.5 minutes), from before the
  box's last start, or lower than the last (a reset) only start a new
  baseline, and that minute is "No reading". After a restart of bb-box,
  counters from the file that are still under 150 s old are used, so a
  quick restart loses no point. A change of capacity (a live resize) starts
  a new point at once.
- **A shared slot** (gate G1, G2). Its Mac is read once a minute for all
  its slots: CPU, memory, disk and the encoder room, kept as the Mac's own
  series. Each slot's point is its own user's processes, read as unit 2
  reads them (see [Decided during unit 2](#decided-during-unit-2)): each
  process's CPU time with its waited-for children's, from
  `proc_pid_rusage`, so the short-lived compilers of a build are counted,
  and its memory footprint. The
  slot is judged against its share of the Mac: the cores and memory the
  shared host sets aside for each slot (064), or where none is set, the
  Mac's cores and memory divided by the slots it can hold. The page says so:
  "40% of its share (1.6 of its 4 cores, of mac-1's 12)". A slot can use more than its
  share, so this can pass 100%. A process that ended with no parent left
  in the slot is not counted, and the page says "its processes". A Mac
  read through its command route has no CPU counters one command can read
  (066), so it has no CPU history.
- **When** (gate G11). Each box has its own second in the minute, from its
  ID, so readings spread over the minute. The queue is fair, and its
  workers grow with the work: as many as the minute's due readings times
  their 90th-percentile time, divided by 50 s, at least 2 and at most 8. A
  reading times out after 10 s. A reading that cannot start within 10 s of
  its second is skipped and counted as skipped. A box whose readings fail 3
  times in a row is read again only when the reach check (above) finds it
  answers. A failed reading calls nothing else.
- **What it keeps** (gate G14). Minute points for 24 hours; hourly points
  for 7 days, each with the mean weighted by the minutes it covers, the
  busiest minute's CPU, the highest memory and how many minutes it covers.
  An hour with fewer than 30 covered minutes is marked partial, and the
  read-out says "partly read". For each point, the reasons the Monitor's
  rules judged it high: CPU, CPU pressure, memory, memory pressure, disk,
  and for a box with its own kernel, five-minute load against its cores.
  Times when the Monitor or box history was off are kept too, as intervals
  that survive turning them on again and restarts, so the chart says "Not
  read" there rather than "No reading" (gate G13).
- **Where** (gate G18). `boxhistory`, attached as above. Old points are
  pruned by age before each minute's writes. A released or forgotten box's
  points go 24 hours after it. If the file ever fills, history stops
  writing, says so in Monitor settings and the doctor, and starts again
  once pruning makes room; nothing else is affected.
- **Its switch.** Under Monitor in settings, "Keep each box's history",
  saved through 067's write engine like every other setting. With the
  Monitor off, nothing is read at all, Live included. With only box history
  off, nothing is read in the background, but a box's page and the
  Monitor still read it live while they are open. What was kept stays on
  show until it ages out.

#### It reverses 066's opt-in, for boxes, and why

Decision 066 made background monitoring opt-in: `backgroundMonitoring` is
off by default, so today nothing reads even BB's server unless the person
turns it on. Box history reads every running box in the background, on by
default. The reason: "was it busy, or stopped, an hour ago?" and a busy
flag on rows cannot be answered after the fact, and the page's 1 h, 24 h
and 7 d are empty without it. It differs from 066's background monitoring
in what it costs and does: a light reading once a minute, no
notifications, and its own switch. Whether it is on by default is the
owner's first question below; if unit 3's measurements miss the budget,
it ships off by default, with its minute step unchanged.

#### Its budget, measured in unit 3

| What | Budget, with 30 boxes |
| --- | --- |
| bb-box's server process | under 1% of one core averaged over an hour, its SSH and `docker exec` children included, and under 30 MB more memory |
| A box | under 0.2% of one core averaged over a minute, its children included, on a 2-core box |
| A Mac with 3 shared slots | one Mac reading and 3 slot readings a minute, together under 0.5% of one core |
| Commands and calls | one command a minute for each box read through its route; one host call a minute for each BB machine |
| On-time coverage | at least 99% of the minute readings due for boxes that answer are taken within 10 s of their second; skipped and failed readings counted apart, and boxes that do not answer apart from a busy queue |
| Freshness | every box that answers has a point under 2 minutes old |
| Extra cost while open | with 5 pages or Monitors open, the server's cost stays within the first row's budget |
| Storage | `box-history.db` under 10 MB after 7 days, its write-ahead log under 4 MB |

For scale, Astra's review measured today's full readings on a Linux box:
a route command took 31 ms and 10 ms of CPU and answered 17.5 KB; a cold
host reading took 317 ms, 300 ms of it the wait. A light reading drops the
process list, the second command and the wait. Astra's re-review modelled
a queue of 4 workers with 30 boxes whose readings all succeed in 9.9 s:
19% of readings were skipped while none started late, which is why
coverage, not lateness, is the measure, and why the workers grow.

The minute step stays. If a measure misses its budget, box history ships
off by default and this note records the numbers; there is no 2-minute
fallback, as 1 h's 60 points, each step's busiest minute and the busy
flag's 5 whole minutes all need minute points.

#### `monitor.history` and `allBoxes` (units 3 and 4)

- `monitor.history` (unit 3): a box's points for 1 h, 24 h or 7 d, with
  its gaps and their kinds from the box log and the history's own records,
  and each point's coverage.
- `allBoxes` (unit 4) adds, for each box, its thread's `running` and
  `activeAt`, its busy flag and reason from box history (none when history
  is off or its newest point is over 2 minutes old), and its last start and
  last activity for the Last active sort.

### 11. Words

- States are words, then numbers: "Ready · up 2 h", never "2 h · Ready".
- Durations: "40 s", "12 min", "2 h 14 min", "3 d 4 h"; rows keep the
  first unit or two ("up 2 h"). Times: "today at 4:44 PM", "yesterday at
  4:58 PM", "Tue 27 Oct at 9:10 AM", in the browser's own format.
- Size: "4 cores · 8 GiB memory" on a row, "4 cores, 8 GiB memory, 32 GiB
  disk" on the page.
- Who: "by you", "by the agent in (thread)", "by a bb box command", "by
  bb-box: (why)", "outside bb-box"; nothing when not known.
- A slot's numbers name whose they are: "this slot", "mac-1, all slots".
- Ranges: "Live", "1 h", "24 h", "7 d", described under the chart as "the
  last 24 hours, by 10 minutes".
- No "utilization", "contention" or "instance". A box is a box; a machine
  of the person's own is a machine.

### 12. Look and motion

BB's tokens and components, the hairline cards of the Boxes and settings
pages, the Monitor's pills, and its colours for CPU (green), memory
(amber), disk and download (blue) and upload (violet), in a darker tone of
each on the light theme so that every line has at least 3:1 contrast with
its background (on white: CPU 5.0:1, memory 4.9:1, disk and download
6.7:1, upload 7.1:1). Lines are told apart by more than colour: memory and
upload are dashed, disk dotted, the Mac's line long-dashed, and the legend
shows each line's own pattern. Numbers are tabular. The chart draws no
animation: a new reading replaces the line. Spinners stop under reduced
motion.

### 13. Keyboard, screen readers and narrow windows

- On the list, Tab reaches each row's name, then its actions; Enter on a
  name opens the page. Returning, focus is on that name again.
- On the page, focus starts on the box's name. Tab then reaches the ID and
  Copy link, the thread, the views, Start or Stop, the menu, the notices'
  actions, the range, the legend, the chart, the facts' copy buttons and the
  threads' chips. Shift-Tab from the name reaches the trail.
- The range is a radio group: Tab reaches the chosen range, the arrow keys
  choose another, and a range that cannot be chosen says why.
- The chart is one image, named for what it shows, with a summary of its
  data ("Over the last 24 hours: CPU averaged 31%, highest 78% at 4:10 PM;
  memory last 58%. Stopped from 3:53 PM.") as its description. With focus,
  the arrow keys move a read-out, and a polite live region that is always
  in the page says each point. To be checked with VoiceOver and NVDA in
  unit 2.
- At 390 px: the actions wrap under the name; facts and tiles are two
  across; a row's second line may take two lines and keeps what needs
  attention; the processes drop their PID column; the view's bar drops the
  live numbers below 640 px.

### 14. How it is built

Kept: `RowTitle`, `StatusDot`, badges, `IconButton`, `PageTabs`,
`SearchRow` and the filters, `ThreadChips`, the box actions and their
dialogs (release, resize, new thread, the in-use guard), `JoinHelp`, the
Monitor's `useMonitorSnapshot`, its metric parts (`BigValue`, `Pill`,
`Footnote`, `LoadingText`), `MiddleTruncate`, its load error words and its
stale notice, 060's viewer and the terminal.

New in the app: `BoxPage` and its parts (`BoxHeader`, `BoxNotices`,
`BoxFacts`, `Activity`, `Processes`, `ThreadsCard`, `HowItStarted`,
`Starting`), `HistoryChart`, a range radio group, the route parsing for
`box/…` with where each entry was opened from, the list's kept state,
`rowLine` for the list's second line (and `StatusLine` gains a two-line
form), and the view bar's other views and live numbers.

Each unit is one PR with its tests, a keyboard pass, screenshots at 1440,
760 and 390 px in light and dark, and a live check on a separate BB in a
box: a fresh `npx bb-app` with no account, bb-box installed from the unit's
branch, with boxes made through it. Each owns its part alone.

| Unit | Change | Server additions | Live check |
| --- | --- | --- | --- |
| 1a | `BoxMenu`: the menu's items move out of `BoxRow` and the Machines row into one component. No visible change | None | Every item of the menu on a thread's box and on a machine, in the Box panel, on the Boxes page and in settings, does what it did |
| 1b | The box log, the two files' opening, the reach check, and what the box's view gains from them; a failed release keeps its record | `box-log.db` attached to the SDK's handle, its own migrations and caps; events with who and with what was observed after a failure; release asked and confirmed; forgotten; the reach check; the view's last start, last stop, last failed operation and backend reach | Gates G4 to G7. A stop by the person (the app), an agent (`box_stop`), a command (`bb box`) and from outside (`docker stop` on the host), each logged with who; a start asked and finished; the log kept across a restart of bb-box; tests with a set clock for 24 hours and 7 days |
| 1c | The box's page without Activity: routes and their origins, `from-settings`, old paths, the way back for the page and its views, the header, every state and notice of section 7 but busy (unit 4), Starting, facts, threads, how it started; the widened Stop and Release guard; "Page" in the Monitor's Open menu and "Open on the Boxes page" in the Box panel. Rows still unfold | `boxPage`; `guarded` also asks when the box's own thread is working | Gates G3, G8 and G20. Open it from each entry; reload; back and forward; Command-click into a new tab; old paths, with and without `from-settings`; Stop, Start and Release from the page; a start that fails; a backend removed from settings with a box on it; a host cut off; a released and a forgotten box's link before and after a restart of bb-box; keyboard only |
| 1d | The list opens the page: a row's click, name link and chevron, the inline details removed in the same change, the list's kept state and focus, the search row above the scrolling rows | None | Gate G9. Release from the page and return; 390 px |
| 2 | Activity on Live and the processes: tiles, the shared slot's split against its share, the chart, its read-out, live region and summaries, the range group, colours; the Monitor off, a box it cannot read, a failed reading; Live while stopping | A slot's reading adds its own user's CPU time (with `ps -S`) and memory, and its share, apart from the Mac's | Gates G1, G2, G16 and G17. `stress-ng --cpu 2` in a box against `top` in its terminal, CPU within 5 points; on a Mac box with 3 shared iOS slots, a load in one slot leaves another's CPU its own; the Monitor turned off and on; the chart read with VoiceOver on a Mac box and NVDA on a Windows box |
| 3 | Box history and the page's 1 h, 24 h and 7 d, with gaps, coverage and busiest minutes; its switch through 067's engine | The reader, `monitor.light` in the host entry, `box-history.db` attached as unit 1b proved, its schedule, workers and pruning, `monitor.history` | Gates G10 to G14, G18 and G19. One box stopped for an hour, one loaded for 10 minutes, one whose host is cut off; bb-box restarted half way; every budget of section 10 measured; the switch saved while another setting is saved; tests with a set clock for retention and released and forgotten boxes |
| 4 | The list says how a box is now: the second line, its order and two lines, the busy flag, threads working, the Last active sort | `allBoxes`' additions | Gate G15. A loaded box says busy after 5 minutes and stops after the load ends; a loaded neighbour slot leaves a slot calm; a person takes control; at 390 px the busy words show; a thread finishes and its card says idle |
| 5 | The view's bar: the box's other views as buttons, and its live numbers | None | A desktop box and an Android emulator box (a Linux box with KVM): switch views, then back, with every origin of gate G8, which a switch keeps; the bar's numbers match the page's |

## Gated in unit N

These are the re-reviews' remaining findings, each settled as a rule
above and owned by one unit. A unit lands only when its gates pass in its
live check on a separate BB in a box, as 067's G1 to G9 do. Where a gate
needs a Mac, it uses a Tart or Namespace Mac box where it can, and never a
pool Mac someone else holds.

| Gate | Unit | Rule | Passes when |
| --- | --- | --- | --- |
| G1 slot-share | 2 | A slot is judged, shown and flagged against its share of the Mac: 064's per-slot cores and memory, or the Mac's divided by the slots it can hold (sections 4, 9, 10) | On a Mac box of 12 cores with 3 shared iOS slots, so a share of 4 cores, a slot using 2 cores reads about 50% of its share, not 17% of the Mac; a slot whose processes use 95% of its share for 5 minutes is busy; the Mac at 90% from other slots leaves it calm |
| G2 slot-short-processes | 2 | A slot's CPU counts its processes' exited children (section 10), read from `proc_pid_rusage` as unit 2 found `ps -S` does not on macOS 26 | An `xcodebuild` of a small app in one slot shows on its CPU tile, and in unit 3's history, within 20% of the build's CPU time, measured as the Mac's own CPU above its idle level with no other slot busy (`time xcodebuild` leaves out Xcode's build service, which does the compiling) |
| G3 stop-guard | 1c | Stop and Release ask first when the box's own thread is working, as well as when a thread works on its BB machine, from a row, the menu, the page and a notice's retry; `force` stops it (section 9, question 4) | With an agent working in a box through box tools, Stop from each of the four places asks, names the thread, and stops only after "Stop it anyway"; an idle thread's box stops at once; a machine of the person's own behaves as today |
| G4 attached-files | 1b | `box-log.db` and `box-history.db` are attached to the SDK's handle, with their own migrations, WAL and caps; if `ATTACH` is refused, the tables go in `data.db` under row caps that leave the Monitor's alerts 10 MB (section 10) | On a fresh BB, both files are made and migrated on start, a second start runs no migration again, `PRAGMA boxlog.max_page_count` and `boxhistory.max_page_count` read as set, and filling `boxhistory` past its cap leaves pressure logs still writable; a test with `ATTACH` refused takes the fallback and passes the same checks |
| G5 log-truth | 1b | Release and forget are distinct events; "released" is written only on the backend's confirmation; a restart between confirmation and record removal is finished by observing; a failed log write makes the page claim nothing from the log; events are bounded to 1 KB and the file to 8 MB (section 10) | Forget on a box whose backend was removed says "forgotten", never "released", and leaves no stopped interval; bb-box killed after the backend deletes a container but before the record goes finishes the release on start; with the log file made read-only, a stop still runs and the page says no "by you"; 10,000 events keep the file under its cap |
| G6 outcome-not-state | 1b records, 1c words | A failed operation's words come from what bb-box observed after it, with when; only a confirmed stop makes a "Stopped" interval (sections 7, 10) | A VM that boots but never answers SSH says "bb-box could not confirm its state" or what it observed, not "still stopped"; a stop that times out and then succeeds shows Stopped from the confirmed time; a resize refused after its memory changed names memory as changed |
| G7 host-reach | 1b | The reach check retries a box that does not answer after 1, 5, then every 15 minutes, by BB's connection state or one routed command, never a backend API on its own; the same with history on or off and with the Monitor off (section 10) | With a box's host cut off for an hour, the server logs at most 6 attempts for it, makes no Proxmox, Namespace, Hetzner or boat.dev call until Check now, and the page's "checks again in" matches the next attempt within 10 s, with history on and off |
| G8 origin-in-path | 1c | Where an entry was opened from is in its path (`from-list`, `from-box`, `from-settings`), as `toPluginPanel` carries only a sub-path; the way back goes back in history only to the panel's own last move, and otherwise replaces with the named origin (section 1) | SDK 0.6.15's `toPluginPanel` checked first; then each of Astra's re-review paths: a quick Simulator icon and back focuses that row; after visiting another box, a quick icon and back focuses the new row; settings, a machine's page, Desktop and back return to the page and then settings, also after a reload; a page opened by URL, then Boxes, then browser Back does not return to the page; a row's quick Desktop, a reload, then back goes to the list it names |
| G9 list-return | 1d | The list's search, filters, sort, tab and scroll are kept, every way out of a row records it, and focus returns to that row's name by every way back (section 1) | With a search, a filter and a sort set and the list scrolled, open a box by its name, its chevron, a quick icon and its menu; return each time by the trail, the browser's Back and a view's back: all four kept, focus on that row's name |
| G10 container-limits | 3 | The light reader reuses 066's `containerCapacity` and `containerMemory`, with their inputs in the reading (section 10) | On a 2-core, 4 GiB Proxmox LXC box with `cpu.max` `max 100000`, a two-CPU cpuset and `memory.max` `max`, a `stress-ng --cpu 2` reads about 100% and a 3 GiB allocation about 75%; tests cover an uncapped child cgroup, a fractional quota (`50000 100000`) and a live resize |
| G11 coverage | 3 | Coverage of due readings is the measure, workers grow with the work up to 8, skipped and failed readings are counted apart (section 10) | In the 24-hour run, on-time coverage is at least 99% for boxes that answer; a test with 30 boxes whose readings all succeed in 9.9 s keeps coverage at 99% by growing workers; a box that does not answer is reported apart from a busy queue |
| G12 counters | 3 | Counters older than 150 s, from before a start, or reset, start a new baseline; counters in the file survive a quick restart; a capacity change starts a new point (section 10) | A restart of bb-box taking 30 s loses no point; one taking 4 minutes loses one; a box restarted inside shows no negative or huge CPU; a live resize from 2 to 4 cores starts a new point |
| G13 collection-off | 3 | With the Monitor off nothing is read, Live included; with box history off only open pages and the Monitor read; off intervals are kept and survive turning on again and restarts (sections 4, 10) | With the Monitor off for 10 minutes, the box sees no command from bb-box; with history off for 3 minutes, then on, those minutes still say "Not read" after a restart of bb-box |
| G14 rollups | 3 | An hour's mean is weighted by the minutes it covers, and an hour under 30 covered minutes is marked partial (section 10) | A box read for 20 minutes of an hour at 90% and stopped for the rest shows 90% for that hour, marked partly read, not 30% |
| G15 busy-truth | 4 | Busy only from 5 whole fresh minutes in a row for one reason, including load for a box with its own kernel and a slot's share; never with history off or stale (section 9) | A VM with load 8 on 4 cores for 6 minutes says busy by load; turning box history off removes "Busy" from its row and page within a minute; a box whose newest point is 3 minutes old says nothing |
| G16 stopping-live | 2 | Live stays while a box is stopping, until its readings stop or the stop is confirmed (section 4) | Stop a box whose page is on Live: Live keeps reading until the stop is confirmed, then the card turns to 24 h |
| G17 network-summary | 2 | The network chart is described by its numbers and gaps, as CPU's is (section 4) | VoiceOver and NVDA read the network chart's averages and highest point, and its gaps |
| G18 history-full | 3 | A full history file stops history's writes, says so, and recovers by pruning; nothing else is affected (section 10) | With `boxhistory`'s cap set low in a test, writes stop, Monitor settings and the doctor say so, alerts and the box log still write, and writing resumes once pruning makes room |
| G19 run-shape | 3 | The run is 24 hours on a separate BB with 30 Linux boxes: Docker boxes, Proxmox LXC boxes, a Proxmox VM, and more than 16 boxes read through their route; and 2 hours of it with a Mac with 3 shared iOS slots, on a Tart or Namespace Mac where one is free, never a pool Mac someone else holds | The run's report gives every budget of section 10 for both parts, with what limits each number |
| G20 offline-actions | 1c | With its backend not in settings or not answering, a box's Stop, Start, Resize and New thread on this box are disabled with the reason, in words; a box that does not answer itself keeps Stop, Start and Resize, which go through its backend, and loses only its views and New thread (section 7; the lead's decision during unit 1c) | maple-row's menus and page, and those of a box whose backend's listing fails, offer none of them, each saying why; fern-hollow, which does not answer, can be stopped from its page, and its mark clears once it is stopped |

## Decided by the lead during unit 1c

After unit 1c's independent review, on 30 October 2026:

- **G20 is about the backend, not the box.** Stop, Start and Resize go
  through a box's backend, not through the box, so they are disabled only
  when the backend is not in settings or does not answer (its listing of
  boxes fails). A box that does not answer keeps them: that is how a hung
  VM gets stopped. Its notice says that bb-box cannot reach it and that it
  can still be stopped, started or released, and its mark clears as soon as
  the box is seen stopped or answering.
- **The guard fails safe.** When BB cannot say whether the box's own thread
  works, Stop and Release ask, saying so.
- **A resize's restart asks too.** A resize that needs a restart asks under
  the same guard as Stop and Release, the box's own working thread
  included. This extends G3.

## Decided during unit 2

On 30 October 2026, during unit 2:

- **Live only until unit 3.** The lead chose to show no range group
  until box history exists: Activity has Live and nothing else, and a
  stopped box's card says it is stopped and not read, and since when. Unit
  3 adds the range group with 1 h, 24 h and 7 d. G16 then reads: Live keeps
  reading while the box stops, and once the stop is confirmed the card
  says so.
- **A slot's own CPU and memory, on a Mac.** On macOS 26, `ps -S` adds
  nothing of an exited child to its parent (a shell whose child ran `yes`
  for 3 s reads 0:00.00), and summed resident sizes count shared frameworks
  again for each process (8 GiB for one idle slot). A slot is read with a
  few lines of Python run by `/usr/bin/python3`, which Xcode's tools
  provide: for each of the slot user's processes, `proc_pid_rusage` gives
  its own CPU time, its waited-for children's, its memory footprint, the
  figure Activity Monitor and `top` show (1.8 GiB for that slot), and its
  start; `proc_pidinfo` gives its parent. The reader passes the whole
  160-byte `rusage_info_v2`, with a 64-byte canary after it that must come
  back untouched, or it prints nothing and `ps` is read. It runs only
  where Xcode or the command line tools are installed, as `xcode-select
  -p`, which never prompts, says: on a Mac without them `/usr/bin/python3`
  is a shim that asks on the Mac's screen to install them. Elsewhere, and
  where Python fails, `ps` is read instead, which misses the CPU time of
  exited children, so a build's compilers count only while they run, and
  gives resident sizes rather than footprints.
- **How a slot's CPU is counted between two readings.** A process is known
  by its PID and its start, so a reused PID is a new process. A reading
  says which counters it has: the Python reader's own time and children's
  time, or `ps`'s own time alone; a change between them starts a new
  baseline rather than a step. CPU is each process's growth in its own
  time, and with the Python reader also in its children's time. A process
  that has ended was already counted up to the last reading, so that much
  is owed by the nearest of its ancestors still running, and taken from
  what that ancestor's children's time grows by, in that reading or the
  next; then the debt lapses. So a build's compilers count once, a build
  service that its tool did not wait for takes at most what its waiter's
  children grew by for one reading, and the last moments of a process
  that ends unwaited are lost. A zombie still answers `proc_pid_rusage`
  but not `proc_pidinfo`: it keeps the parent it had, and one never seen
  alive waits to be counted with its parent. With `ps` alone nothing is
  owed, as its counters have no children.
- **A slot is judged on its own numbers only.** When its own reading fails,
  its CPU and memory are not read, and only the disk it shares with the
  Mac can make its health a warning; the Mac's CPU, load and memory never
  do. The page's words and read-out keep a slot's percentages as they
  are, 787% of its share included; only the drawn line stops at the top.
- **The chart is an application with the role description "chart".** As
  an image, NVDA kept browse mode on it, so the arrow keys never reached
  the read-out. It still has the chart's name and summary. While focus is
  on the charts they hold the reading they had, as a screen reader
  otherwise says the changed summary again at each reading.

## Open questions for the owner

The owner answered all four on 29 October 2026, each with its default.

1. Box history, read once a minute and kept 7 days, is on by default, as
   long as unit 3 meets its budget. This reverses 066's opt-in background
   monitoring, for boxes only (section 10). Default: yes; off by default if
   the budget is missed, with no slower step instead.
2. A click on a row opens the box's page, and the details no longer unfold
   in the row. Default: yes.
3. A row says when a box has been busy for 5 whole minutes, and nothing
   else from the Monitor. Default: yes.
4. Stop stays one click on a wide row, and in the menu on a narrow one.
   Today it asks first only when a thread works on the box's BB machine,
   not when the box's own thread is working through box tools, so one
   click can stop the box an agent is using. Unit 1c widens the guard to
   ask in that case too. Default: yes, keep one click and widen the
   guard; the other choices are Stop only in the menu, or one click with
   today's narrower guard.

## Alternatives considered

- A drawer from the right on a row's click, keeping the list beside it.
  It would have a link, but a chart and a table of processes need the
  page's width, a drawer is a second place to scroll, and the owner asked
  for a page like boat.dev's.
- Richer details unfolded in the row. No link, and the list would jump
  as rows grow by 600 px.
- Opening a box in the Monitor instead, with a larger Monitor. The Monitor
  is a glance from anywhere in BB, in the sidebar's width; the page is
  where a box is looked at closely. They share their readings, not their
  layout.
- boat.dev's list as a table, with columns for type, cost and a usage
  chart. The owner ruled it out, and it would make every row about numbers
  that rarely matter.
- History from the Monitor's own sampler, once a minute. Its readings
  start cold, so each point would be 300 ms, not a minute, and each one is
  a full reading. Section 10's light reader with kept counters replaces it.
- History off by default until asked for. It would leave 1 h, 24 h and
  7 d empty, and rows unable to say busy, on every install. Question 1
  leaves the choice to the owner, and ties it to the measured budget.
- Stop only in the menu, so a slip cannot stop a box. The widened guard
  protects a working thread, and stopping is weekly work; question 4 keeps
  today's one click.

## The prototype

Open [069-boxes-page/prototype.html](069-boxes-page/prototype.html) in a
browser. It is one file with nothing to install and saves nothing. It uses
bb-box's own row title, badges, tabs, search and filters, thread chips and
the Monitor's metric parts and middle truncation, with BB's buttons, menus
and dialogs. A fake server holds ten boxes under generic names and answers
Stop in about 1.6 s, Start in about 3.2 s and Release in about 1.4 s, and
keeps a box log: who stopped or started a box, and released boxes. Each
page has its own link in the URL's hash, as the real one will have a
path, so back, forward and reload work. Add `?light` for the light theme.
Its numbers are made up, but move: Live adds a reading every 5 s.

The dashed Prototype panel, bottom left (top right on a phone), goes to:
the list, a desktop box, a device box on a shared Mac, a stopped box, a
busy box, a failed box, a machine of the person's own, a host that does
not answer, a backend removed from settings, a Windows machine, and a
settings stand-in with the Monitor's switches and a machine opened from
settings. It also makes the next Stop, Start, Resize or Release fail, turns
the Monitor off and on, and switches dark and light.

Screenshots, at 1,440 px wide unless named: [the Threads
tab](069-boxes-page/new/01-list-threads.png), [the Machines
tab](069-boxes-page/new/02-list-machines.png), [a desktop
box](069-boxes-page/new/03-desktop-box.png), [a device box on a shared
Mac](069-boxes-page/new/04-device-box-shared-slot.png), [a stopped
box](069-boxes-page/new/05-stopped-box.png), [a busy
box](069-boxes-page/new/06-busy-box.png), [a failed
box](069-boxes-page/new/07-failed-box.png), [a starting
box](069-boxes-page/new/08-starting-box.png), [a desktop
opened](069-boxes-page/new/09-desktop-opened.png), [a busy box at 390
px](069-boxes-page/new/10-phone-box.png), [the list at 390
px](069-boxes-page/new/11-phone-list.png), [light](069-boxes-page/new/12-light.png),
[a point read on the chart](069-boxes-page/new/13-stopped-read-out.png), [a
host that does not answer](069-boxes-page/new/14-host-not-answering.png),
[a backend removed from settings](069-boxes-page/new/15-backend-removed.png),
[a Windows machine bb-box cannot read](069-boxes-page/new/16-windows-machine.png),
[a busy box at 760 px](069-boxes-page/new/17-760.png), [a stop that
failed](069-boxes-page/new/18-stop-failed.png) and [a release that did not
finish](069-boxes-page/new/19-release-failed.png).

Worth trying:

1. Search the list for "amber", open amber-fox's page, then come back with
   the trail or the browser's Back: the search and focus are kept.
2. Open a desktop from a row's icon, then its back arrow: straight back to
   the list. Open it from the page instead: back to the page.
3. On amber-fox, Tab to the chart and use the arrow keys; Tab to the range
   and use the arrow keys. Choose 24 h and 7 d.
4. On silver-pine: the header says its last stop was by you, How it
   started says an agent last started it, and 24 h shows both stops and
   the busiest minutes above a quiet line. Press Start: "Starting again for
   0 s", then "Last started … by you". Then Stop.
5. Turn on "The next Stop, Start, Resize or Release fails", then Stop
   amber-fox, or Release brisk-lake.
6. Open fern-hollow (its host does not answer) and maple-row (its backend
   was removed): Forget… maple-row.
7. On calm-harbor, the shared slot: its own numbers, the Mac's, and its own
   processes.
8. In Settings, open workbench's desktop, then go back: to settings.
9. Turn the Monitor off, or box history off in Settings, and look at a
   box's 24 h.
10. Narrow the window to a phone's width.

What it does not do: real readings, the history's server, resize and new
thread (they show a note), a box's tailnet name, a gone box, a device that
did not boot, a failed join to BB, the Monitor in BB's footer and its new
Page item, the Box panel's new item, the old `<threadId>/<boxId>` paths,
and a released box after a reload (the real one keeps it 24 hours).

The prototype has done its job and will not change again. Where it and
this note differ, the build follows the note, and the gates prove it. The
re-reviews found these differences:

- It keeps where an entry came from in the browser's history state, which
  BB's `toPluginPanel` cannot carry; the note puts it in the path (G8). So
  a quick icon's way back, settings through a page to a view, a reload
  after a quick icon, and a page opened by URL behave as G8 says, not as
  the prototype does.
- It shows a slot's CPU and memory as shares of the whole Mac, not of the
  slot's share (G1).
- A failed Start says "It is still stopped" without an observation (G6).
- Forget shows "was released" (G5).
- With box history off, a busy row and page still say busy (G15); turning
  history on again forgets the off interval (G13); Live gives way to 24 h
  as soon as a stop is asked for (G16).
- The network chart's description names its lines, not its numbers (G17).
- Stop on a working thread's box does not ask (G3), and maple-row's menu
  still offers New thread on this box (G20).

To rebuild it, on a box: `npm ci` at the repository's root, then `npm ci`
and `npm run build` in `docs/decisions/069-boxes-page/prototype`, which
writes `prototype.html` beside the folder. `npx tsc -p tsconfig.json
--noEmit` there typechecks it.

## Consequences

- The Boxes page's rows no longer unfold; the details, and more, are one
  click in.
- bb-box reads each running box once a minute while box history is on,
  within the budget of section 10, and keeps two small files of its own,
  `box-log.db` and `box-history.db`.
- `BoxMenu` becomes the one place a box's menu is defined, for the row,
  the page and the Machines tab.
- 066's "no monitoring on the box page" now applies to the thread's Box
  panel only, and its opt-in background monitoring still applies to BB's
  server and the person's machines.

## What changed after the reviews

Two independent reviews, by Opus and by GPT-6 Astra, read the note and ran
the prototype on a box. Both said: build after changes, not a rethink.
Every finding of both is answered here.

| Finding | Reviews | Change | Where shown |
| --- | --- | --- | --- |
| History had no collection contract: each minute's point would be a cold 300 ms sample of a full reading; the queue had no bound on lateness or backlog | Opus 2, Astra 1 | A light reader of its own, counters kept between minutes so a point is the minute's mean with its covered interval, missing-sample rules, each box at its own second, a fair queue of 4 with a 10 s timeout and skips, back-off, no backend calls on failure | Section 10, "Box history: what is read, and how" |
| History had no real budget, and was measured on one path | Opus 2, Astra 1 and its cost check | A budget for the server, each box, a Mac with slots, commands, lateness and storage; measured in a 24-hour run with Docker, LXC, a VM, more than 16 route-read boxes and a Mac with 3 slots; off by default if missed (the 2-minute step was dropped after the re-reviews) | Section 10, "Its budget"; section 14, unit 3 |
| History shared the Monitor's database with alerts, with a page cap | Opus 2 | Its own file, `box-history.db`, pruned by age, capped on its own; alerts never affected | Section 10, "Where" |
| History reversed 066's opt-in without saying so | Opus 2, Astra 1 | Said plainly, with why, its own switch through 067's engine, and question 1 asks the owner; off if the budget is missed | Section 10, "It reverses 066's opt-in"; question 1; prototype Settings stand-in |
| A shared slot showed the Mac's numbers as its own, and could be flagged busy for a neighbour | Opus 2, Astra 4 | The slot's own CPU and memory from its own user's processes; the Mac's numbers labelled as all slots', with the encoder room; busy only from its own processes; the Mac read once for all its slots | Sections 4, 5, 9, 10; prototype calm-harbor, [screenshot](069-boxes-page/new/04-device-box-shared-slot.png) |
| Stops, "stopped by you", start times and released boxes needed records bb-box does not keep | Opus 3, Astra 2 | The box log, `box-log.db`: events with time and who, the last start asked and finished, released boxes kept 24 hours; words leave out what is not known | Sections 6, 7, 10; prototype silver-pine's Start and Stop |
| "Starting for 1 d 2 h" after Start on a stopped box | Opus 3, Astra 2 | A restart counts from when Start was asked, and shows the start's own steps | Section 7; prototype silver-pine |
| No state for a failed stop, start, resize or release, a removed backend, or a host that does not answer; today's row notices dropped | Opus 7, Astra 3 | Operation results kept apart from state; a notice for each with its recovery; Forget… for a removed backend; a failed release keeps its record; a device that did not boot; today's lines under a row stay | Sections 7, 9, 10; prototype fern-hollow, maple-row and the fail switch, [screenshots](069-boxes-page/new/18-stop-failed.png) |
| A view's back always went to the box's page, and pushed a new entry | Opus 1, Astra 7 | Back returns to where the view was opened from, by going back in history; from a link or reload it replaces itself with the page | Sections 1, 8; prototype, worth trying 2 |
| 067's `from-settings` way back was lost | Opus 4, Astra limits | Kept on the new paths and the old ones; settings opens a machine's page with it | Section 1; prototype Settings stand-in |
| Returning to the list lost the search, scroll and focus; the chevron did nothing; the search row scrolled away | Astra 6 | The list's state kept for the session, focus back on the opened row or its neighbour; the chevron is the page's link; the search row stays above the rows | Sections 1, 9, 13; prototype, worth trying 1 |
| At 390 px a row lost what needed attention, leaving colour alone | Opus 5, Astra 5 | The second line puts what needs attention before age and size, in words, and may take two lines | Section 9; [screenshot](069-boxes-page/new/11-phone-list.png) |
| At 390 px the process name was cut first | Astra 5 | The PID column goes below 640 px; names cut in their middle | Section 5; [screenshot](069-boxes-page/new/10-phone-box.png) |
| Facts came before how the box is now | Opus 6 | Activity and processes come before the facts | Section 3; [screenshot](069-boxes-page/new/03-desktop-box.png) |
| The box ID and the link were buried at the foot | Astra 10 | Both in the header, under the state | Section 2 |
| A busy box's words should lead to the reason | Opus 6 | They link to the processes | Section 2 |
| Stop left the row, making a weekly task slower | Astra 7; Opus 10 agreed with leaving it | Stop stays one click on a wide row, guarded as today, and in the menu on a narrow one; question 4 | Section 9; question 4 |
| Finding boxes that can go needs a sort by activity | Opus 10 | Sort gains Last active | Section 9; prototype Sort menu |
| The two charts' plots did not line up; ticks were uneven | Opus 9 | One plot width for both; ticks at whole steps | Section 4 |
| The read-out's live region appeared with its text, and the chart named its series, not its data | Opus 9, Astra 8 | A live region always in the page, and a summary of the data as the chart's description | Section 13 |
| Home and End scrolled the page; arrow keys did not move the range | Astra 8 | Chart keys are consumed; the range is a radio group with arrow keys | Sections 4, 13; prototype, worth trying 3 |
| Light-theme lines were under 3:1, and lines were told apart by colour only | Astra 8 | Darker lines on the light theme, each at least 4.9:1; dashes and dots per line, shown in the legend | Section 12; [screenshot](069-boxes-page/new/12-light.png) |
| Screen readers not checked | Astra 8 | VoiceOver and NVDA in unit 2's live check | Section 14, unit 2 |
| "Turn it on" was not a link; "Warm pool" was the code's word; the Resize cell was hard to read; Tab order did not mention the trail | Opus 9, 10 | A link to Monitor settings; "Took a warm box"; "Disk now; cores and memory with a restart"; section 13 says Shift-Tab reaches the trail | Sections 3, 4, 6, 13 |
| Stopping hid Live | Opus 7 | Live stays until it has stopped | Section 7 |
| Unit 1 was too large, rows changed in one unit and their details went in another, two units owned the way back, server additions had no unit, unit 4 needed unit 3 unsaid, unit 3's 3-hour run could not prove a day | Opus 8, Astra 9 | Units 1a to 1d, 2 to 5, each owning its part alone with its server additions; rows change in one unit; history before the busy flag; a 24-hour run with a set clock for retention | Section 14 |
| Turning collection off should not hide what was kept; gaps should say why | Astra 2 | Kept history stays on show; gaps say Not read, No reading, Starting or Stopped, and only the box log says Stopped | Section 4; prototype with the Monitor or history off |

## What changed after the re-reviews

Both re-reviews, of revision a7e55010, said: build after these changes,
each belonging to one build unit. This revision changes the note only;
each point is a rule above, owned by one unit, and proved by its gate.

| Finding | Re-review | Settled as | Gate |
| --- | --- | --- | --- |
| A slot judged against the whole Mac could never be busy, and its history missed short builds | Opus 1 | A slot is judged against its share of the Mac; `ps -S` counts exited children; proved with an `xcodebuild` in a slot | G1, G2 (unit 2) |
| The Stop guard does not cover the box's own working thread | Opus 2 | The guard widens to ask when the box's own thread is working, from every place Stop and Release are offered; question 4 says what today's guard does not do | G3 (unit 1c) |
| The two new files had no way to be opened, migrated or capped beside the SDK's single `data.db` | Opus 3 | Attached to the SDK's handle, with their own migrations, WAL and caps; a fallback inside `data.db` that leaves the alerts 10 MB | G4 (unit 1b) |
| Nothing owned "tries again" for a host that does not answer | Opus 4 | The reach check: its schedule (1, 5, then every 15 minutes), its way (BB's connection state or one command), no backend API on its own, the same with history on or off | G7 (unit 1b) |
| "Where it was opened from" cannot ride on `toPluginPanel`; settings' way back was lost through a page | Opus 5, Astra 5 | The origin is in the path, carried through page and view; going back in history only to the panel's own last move, replacing otherwise; checked against SDK 0.6.15 first | G8 (unit 1c) |
| The counters' 150 s limit broke the 2-minute fallback; a restart's effect was said two ways | Opus 6, Astra 4 | No 2-minute fallback: history ships off if it misses its budget; counters from the file survive a restart under 150 s | G12 (unit 3) |
| The busy rule dropped load | Opus 7 | The reading includes `/proc/loadavg`; load is a reason for a box with its own kernel | G15 (unit 4) |
| Focus after a view's back to the list; New thread offered on an offline box; a day-long Mac in the run; the server's SSH children | Opus 8 | Focus on that row by every way back; New thread disabled with the reason; the Mac part runs 2 hours on a Tart or Namespace Mac; the budget counts children | G9 (1d), G20 (1c), G19 (3); section 10's budget |
| The light reader dropped 066's container limits | Astra 1 | It reuses `containerCapacity` and `containerMemory`, with their inputs in the reading | G10 (unit 3) |
| A failed request does not establish the resulting state | Astra 2 | An operation's outcome is kept apart from the observed state, with when; only a confirmed stop makes a stopped interval | G6 (unit 1b records, 1c words) |
| Forget became a false release; log failure and restart boundaries were open | Astra 3 | A "forgotten" event and page; "released" only on confirmation; a restart in between finished by observing; a failed log write claims nothing; bounded events and file | G5 (unit 1b) |
| The budget could pass while readings were lost; the reader's cost beside Live was implied shared | Astra 4 | Coverage, freshness and the extra cost while open in the budget; workers that grow with the work; the reader says it does not share with Live | G11 (unit 3) |
| Monitoring states contradicted the note: Live while stopping, busy with history off, off intervals; the switch sentence | Astra 6 | Live stays until the stop is confirmed; no busy with history off or stale; off intervals kept across re-enable and restart; with the Monitor off nothing is read | G16 (2), G15 (4), G13 (3) |
| The network chart lacked a numerical description | Astra 7 | Described by its averages, highest point and gaps | G17 (unit 2) |
| Further cases for the units' checks: the guard on retries, filters and sort kept, rollups and partial coverage, full storage, slow readers, counter resets and capacity changes | Astra, build units | Each in its unit's gate | G3, G9, G14, G18, G11, G12 |
