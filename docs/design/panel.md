# Design: the Box panel and the desktop

How bb-box looks and reads in BB: the Box panel in a thread, the desktop
tab, and the Desktops page. The settings page is in
[settings.md](settings.md). Mockups are in [mockups](mockups/): the HTML
renders every screen in BB's dark and light themes, and the PNGs beside it
are its output.

## Why

The first panel worked but read like a settings form: a native select
("Linux headless (2 cores, 4 GiB memory, 16 GiB disk)"), a "New box" button,
a line of description, and "This thread has no boxes. Make one here, or ask
the agent to use box_acquire." The operator asked for a panel that feels
part of BB (1 October 2026), and for people and agents to choose a box's
size ([#58](https://github.com/moonstead/bb-box/issues/58), decision 028).

## Rules

- **Match BB; invent nothing.** Every surface uses BB's own components,
  vendored from its registry at the installed version: rows, menus,
  popovers, dialogs, switches, status dots, empty states. Colours come from
  BB's theme tokens, never literals, so custom palettes and both themes work.
- **Calm by default.** A row says what matters now: the box's name, kind
  and state. The rest is one click away. Nothing pulses or flashes; a
  spinner shows only while something is happening.
- **Plain words.** No tool names, kind IDs, VMIDs or internal states in
  front of people. "Linux desktop", not `linux-desktop`; "Release", not
  `box_release`. A refusal says what to do instead.
- **One place per action.** New boxes come from one button. A box's actions
  are on its row. Confirmation only for release, the one thing that deletes.
- **Works narrow.** The thread panel is often 360 px wide. Rows wrap their
  status line and never clip the name. On compact viewports BB's menus and
  popovers become bottom drawers; the vendored components do that.

## Names

Kinds follow the operator's decisions of 1 October 2026: a kind is named by
its OS, and what it has reads as badges or, in the picker, as the row's
name within its OS group.

| Kind ID | Box row | Picker row, under its OS | Icon |
| --- | --- | --- | --- |
| `linux` | Linux [LXC] | Terminal | server |
| `linux-desktop` | Linux [Desktop] [GPU] [LXC] | Desktop, GPU | monitor |
| `linux-desktop-cpu` | Linux [Desktop] [LXC] | Desktop | monitor |
| `linux-arm64`, `linux-arm64-desktop-cpu` | Linux [arm64] [VM], Linux [Desktop] [arm64] [VM] | Terminal, arm64; Desktop, arm64 | server, monitor |
| `macos`, `macos-desktop` | macOS [VM], macOS [Desktop] [VM] | Terminal; Desktop | server, monitor |
| `windows-desktop` | Windows [Desktop] [VM] | Desktop | monitor |
| `windows-arm64-desktop` | Windows [Desktop] [arm64] [VM] | Desktop, arm64 | monitor |

`linux-docker` and `linux-arm64-docker` are aliases an agent may ask for,
never rows (041: every Linux box has Docker). The panel shows the OS and
the badges; the IDs appear nowhere.

### Badges

BB's chip (its machine picker's and settings sections' small bordered word)
sits after a kind's or a box's label, in the Kinds rows, the box rows, the
New box options and the desktop lists:

- **Desktop** for a kind or a box with a desktop.
- **GPU** where the kind takes one. A box of a GPU kind whose display fell
  back to the CPU says "Display on the CPU" in its status line, in warning
  text; otherwise the status line does not repeat the badge.
- **No Docker** for a Linux kind none of whose offers has Docker, and a
  Linux box without it (041: every other Linux box has Docker, so only its
  absence is said). Other systems never had Docker, so they carry none, and
  nor does a kind whose offers differ.
- **arm64** for a Linux (or later Windows) kind on arm64 (040,
  `linux-arm64` and its desktop), so two Linux rows read
  apart. macOS runs on arm64 only, so it carries none.
- **What the box is**, one word from its backend's driver: LXC, Container
  (the Docker backend's, so the word Docker means the feature, 041), VM
  or Physical. A kind on offer from several backends shows each once.
- **Ready now**, in the New box options only, last, on a kind with a spare
  box ready (032), so a box of it comes at once. A box claimed from a spare
  needs nothing more: its status line says "Ready in 0.1 s".

In that order. Nothing else is a badge; the backend's name is in the row's
details. Calm, not stacked.

Badges never squeeze a name. In the New box options they sit on a line
of their own under the label (the operator's annotation of 1 October 2026:
Linux's four badges had left one letter of its name). In a row the title
line wraps, so badges go under the name before the name would truncate.
bb-box's own icon is a cube; BB has no cube, monitor, server or terminal glyph, so the
plugin declares its four as SVGs (`bb.branding.experimental_icons`), drawn
in the weight of BB's set.

## The Box panel

A thread panel tab titled "Box" (`layout: "padded"`, so BB gives it its
usual padding and scrolling). The operator asked for the singular on the
tab (1 October 2026): one tab, one place for the thread's boxes.

### Layout

```
+------------------------------------------------------------+
| 3 boxes                                                [+] |   toolbar
+------------------------------------------------------------+
| [=] quiet-fern  Linux [LXC]                            ...  |   row
|     (spinner) Starting · 1.4 s · 2 cores · 4 GiB · 16 GiB   |
|------------------------------------------------------------|
| [#] bold-heron  Linux desktop [GPU] [LXC]        [#] [>_] ... |
|     (green) Ready in 2.2 s · BB machine in 5.3 s ·          |
|     4 cores · 8 GiB · 32 GiB · You have control             |
|     Address     10.200.0.14                                 |   details, when open
|     Backend     Proxmox LXC on pve                          |
|     ...                                                     |
|------------------------------------------------------------|
| [=] calm-otter  Linux [Physical]                [>] ...     |
|     (ring) Stopped · 8 cores · 16 GiB · 64 GiB              |
+------------------------------------------------------------+
```

- **Toolbar**: a count on the left in muted text ("3 boxes"; nothing when
  there are none) and a plus on the right: BB's ghost icon button, with
  the tooltip and accessible name "New box" (the operator asked for the
  button without a label or border, 1 October 2026).
- **List**: BB's list panel (`rounded-lg border bg-card px-4`), one row per
  box, divided by hairlines, newest last so a new box appears where the eye
  is after pressing the button.
- **Row**: BB's resource row. A leading glyph (server or monitor), the name
  in `text-sm font-medium`, the kind label beside it in muted `text-xs`, its
  badges (wrapping under the name when the row is narrow), and a status line
  below in muted `text-xs`. Trailing: the row's quick actions
  and its menu, always visible, since the panel is narrow and touch is
  common.
- **Click** on the row (not on a button) opens its details under the status
  line; click again closes. Only one row's details are open at a time.

### The status line

One line, items separated by BB's middle dot. The first item is the state
with a status dot in BB's tones (success, warning, destructive, and the
hollow ring BB uses for offline), or a spinner while something is in
progress.

| State | Line |
| --- | --- |
| acquiring, starting | (spinner) Starting · 1.4 s, the time ticking from the request |
| ready, joining BB | (green) Ready in 2.2 s · Joining BB… |
| ready, BB machine | (green) Ready in 2.2 s · BB machine in 5.3 s |
| ready, enrolment off | (green) Ready in 2.2 s |
| ready, enrolment failed | (green) Ready in 2.2 s · Could not join BB (warning text; the reason is in the details) |
| ready, after a restart | (green) Ready |
| stopping, releasing | (spinner) Stopping… / Releasing… |
| stopped | (ring) Stopped |
| failed | (red) Failed, with the backend's reason on a line below, in destructive text |
| gone | (red) Gone · deleted outside bb-box |

After the state come the size ("4 cores · 8 GiB · 32 GiB"; the disk is left
out when it is the base disk), "GPU" or "CPU" for a desktop, and for a
desktop someone controls, "You have control" or "Someone else has control"
in foreground text. A refused change ("Stopping the box failed: the host did
not answer.") shows as a second line in destructive text until the next
change.

### Details

A two-column grid in `text-xs`, labels muted:

| Label | Value |
| --- | --- |
| Address | 10.200.0.14 |
| Backend | Proxmox LXC on pve |
| System | Linux x86_64, with docker |
| each guest fact | GPU, Display, Reason, Template, as the backend gives them |
| BB machine | its name and whether it is connected; "off" when enrolment is off; "not for this kind" when its kind cannot enrol, as Windows cannot yet; the error when it failed |
| Timings | clone 0.75 s · start 1.0 s · ssh 0.45 s · total 2.2 s · BB enrolment 5.3 s |
| Made | 12 minutes ago |

### Quick actions and the menu

Quick actions are BB's ghost icon buttons with tooltips: "Open desktop"
(desktop boxes, when ready), "Open terminal" (once
[#51](https://github.com/moonstead/bb-box/issues/51) exists, for boxes that
are BB machines), "Start" on a stopped box, "Stop" on a running one that can
stop. The menu (BB's overflow menu, three dots) repeats them and adds the
rest:

1. Open desktop
2. Open desktop in a browser tab
3. Open terminal
4. Copy address
5. separator
6. Stop or Start, where the backend can
7. Check now (asks the backend for the box's state; disabled while a change
   is in progress)
8. separator
9. Release…, in BB's destructive menu style

Items that do not apply are left out, not disabled, except "Check now".

### Release

"Release…" opens BB's alert dialog:

> **Release bold-heron?**
> Its disk and everything on it will be deleted. Copy out anything you want
> to keep first.
> [Cancel] [Release]

For a real machine: "The machine will be reset and returned to its pool.
Anything in the box user's home will be deleted."

### New box

The plus opens a popover (a bottom sheet on compact viewports) with one
small form. On a viewport of 640 px or more it has two columns, a detail
pane left of the list, as the operator asked (1 October 2026); narrower,
the pane sits under the list, above Size.

```
+--------------------------------+---------------------------------------+
| [#] Linux desktop on a GPU     | Kind                                  |
| [P] Proxmox LXC on pve1   |  Linux                                |
|     · LXC container · 1 ready  |   (o) [=] Terminal        [P][m][D]   |
|     now · usually about 3 s    |           [LXC] [Physical] [Container]|
|                                |           [Ready now]                 |
| System    Linux x86_64 · root  |   ( ) [#] Desktop, GPU        [P] pve |
|           through sudo         |           [LXC]                       |
| Has       a desktop on the GPU |   ( ) [#] Desktop          [P][D]     |
|           · computer use ·     |           [LXC] [Container]           |
|           follows the panel's  |  macOS                                |
|           size · Docker        |   ( ) [#] Desktop        [L] 2 Macs   |
| BB machine yes: Git            |           [VM]                        |
|           credentials, machine |  Windows                              |
|           variables, child     |   ( ) [#] Desktop         [P] pve     |
|           threads              |           [VM]                        |
| Sizes     Small 4 cores · 8    | Size                                  |
|           GiB (default) · ...  |  [ Small ] [ Medium ] [ Large ] [ Custom ] |
|                                |  4 cores · 8 GiB memory · base disk   |
|                                | [ Create ]                            |
+--------------------------------+---------------------------------------+
```

The popover has no heading of its own: the button that opens it is named
"New box", so its first line is "Kind" (the operator's annotation of
1 October 2026, and a later one the same day took the colons off). "Kind"
and "Size" are the section labels, in
`text-xs font-medium text-foreground`, so they stand above their options
(a second annotation the same day). On a compact viewport the bottom sheet
still carries the title "New box".

- **Kind** is a list of options grouped by OS (Linux, macOS, Windows, as
  small group labels), each option named by its tools within the group,
  "Terminal" or "Desktop", with GPU and arm64 in the name ("Desktop, GPU",
  "Terminal, arm64"), so a list is never "Linux, Linux, Linux" (the
  operator's note of 1 October 2026). Under the name, on a line of its own,
  the badges say what the boxes are (LXC, Container, VM, Physical), "No
  Docker" for a Linux kind no offer of which has Docker (041), and "Ready
  now" when a spare is ready (032). At the right, a provider mark per
  offer: the provider's glyph (Proxmox, Docker, a laptop for a Mac, a plug
  for a pool machine)
  and the host's name when the kind has one offer. Options are chosen with
  a click or the arrow keys; the chosen one is highlighted with a check.
  The list comes from the kinds on offer, so a new backend's kinds need no
  panel change. Descriptions stay where agents read them, in `box_list`
  and the skill.
- **The detail pane** follows the pointer over an option or the keyboard
  focus, and shows the chosen kind otherwise, so it is never empty. It
  gives the kind's full name ("Linux desktop on a GPU"); each offer in
  acquire order, with the provider and host ("Proxmox LXC on pve1",
  "Tart on 2 Macs", "SSH host pool"), what the boxes are, spares ready
  now, free pool machines and the usual cold start ("usually about 3 s",
  the median of the kind's last five on that backend); "the first with
  room, in that order" when there are several; then System (OS, arch,
  root or Administrator), Has (a desktop and how it is drawn, computer
  use, follows the panel's size, Docker), Lacks when something is missing
  (Docker on Windows), BB machine (yes with what that gives, or no with
  what that costs), and Sizes, each fact a row with a dim small label
  above its words (two columns wrapped into a mess at the pane's width,
  the operator's note of 1 October 2026). Names read at full strength: the
  kind's, and each provider's in its brand colour (Proxmox orange, Docker
  blue, a neutral for a Mac's laptop and a pool machine's plug, shades
  that read on light and dark); the rest is dim: "or", what the boxes
  are, the usual start, the sizes; "ready now" is green. Every option
  describes itself by the pane (`aria-describedby`), so a screen reader
  hears the details after the name on focus; the pane is not a live
  region, so hovering says nothing.
- **Glyphs** the panel draws itself (`src/app/glyphs.tsx`): the server,
  monitor, terminal, laptop and plug, and the Proxmox and Docker marks,
  are inline SVG with their size reserved, so they show at once and nothing
  moves when they appear (the operator's note of 1 October 2026). The same
  drawings sit in `assets/` for BB's own places, the tab and the settings
  page.
- **Where the box goes** (044): when the pane shows the chosen kind and
  the kind has more than one offer, its offers are a choice, a radiogroup
  named Provider: "First with room · in this order" comes first and is
  chosen at first, then each offer with its words. The form sends the
  chosen offer's backend ID as `on`; the first with room sends nothing.
  Choosing another kind puts the choice back; it is not remembered. A kind
  under the pointer keeps its offers as plain text. Tab order: kinds, the
  provider choice when there is one, Size, Name, Create. A refusal shows
  under the button, as other refusals do. Add machine (036) is the same
  form, so it has the same choice.
- **Size** follows decision 028: Small, Medium and Large are the kind's
  presets, and the kind's default preset is chosen at first; being chosen
  says so, so nothing calls it the default. The chosen size's words sit
  under the control as a caption ("2 cores · 4 GiB memory · base disk"), in
  BB's `text-xs` at 12 px and the subtle foreground, as are the custom
  fields' labels; the operator asked for the caption at about 12 px
  (1 October 2026). Custom shows three fields, cores, memory in GiB and
  disk in GiB, each with "up to" the kind's largest, starting from the
  preset the person was looking at; a field left empty takes the default
  preset's value, and an empty disk keeps the base disk. The form sends a
  preset by name, or the custom fields, and nothing for the default.
- **Create** is the one primary button. Enter does the same. The popover
  closes, and the new row appears with "Starting".
- The form remembers the last kind and size in the browser, keyed by plugin
  ID, so the next box is two clicks.
- A refusal (no room, the thread's limit, a size above the largest) shows
  under the button in destructive text, with the backend's words, and the
  popover stays open so the person can pick another size or kind.
- The pane's data comes with each kind (`KindView.offers`,
  `computerUse`): the registry keeps the last five cold starts of each kind
  on each backend and counts spares ready per backend, and a real backend
  gives its free machines from its last survey.

### The box this thread runs on

A thread that runs on a box's BB machine, one of your machines (036) or
another thread's, shows that box first, under the caption "This thread
runs on it", in a card of its own above the thread's boxes; the count
above the list counts the thread's own. The row is the box row with a
"Yours" badge for your machine, and without Stop, Start, Release or "New
thread on this box": a line under its status says where those are,
"Remove or stop it in BB Box's settings." (a link), or names the thread
that holds it, "Held by <title>", which opens that thread. Open desktop,
Open terminal, Copy address and Check now stay.

### Empty states

- **No boxes**: BB's dashed empty panel: "No boxes yet", then "A computer
  for this thread." The operator asked for that line to stay this simple
  (1 October 2026). The toolbar's plus is the action; the panel does not
  repeat it.
- **No backend on**: "BB Box is not set up yet. Set a backend up in its
  settings and turn it on." with an "Open BB Box settings" button that goes
  to the plugin's settings page. No "New box" button.
- **Loading**: BB's skeleton rows, shown only after 200 ms so a fast load
  does not flash.
- **Could not load**: the error in BB's empty panel with "Try again".

### Live updates

The panel refetches on bb-box's change signal for its thread and after a
reconnect, as before. While a box starts, the row's time ticks every 100 ms
from the record's `createdAt`, so the panel feels alive without polling.
When the box is ready, the ticking stops and the row shows the real timings
from the record.

## The desktop tab

A thread panel tab per desktop box (`layout: "flush"`), opened from a row,
titled after the box.

```
+------------------------------------------------------------------+
| [#] bold-heron  (green) The agent has control    [Take control] … |
+------------------------------------------------------------------+
|                                                                  |
|                        the desktop, scaled to fit                |
|                                                                  |
+------------------------------------------------------------------+
```

- **Toolbar**: BB's recessed bar (`border-b bg-surface-recessed px-3 py-2
  text-xs`): the monitor glyph, the box's name, then the state in muted
  text with a status dot. On the right the one action that matters now,
  and a menu with the rest ("Open in a browser tab", "Reconnect", "Open
  thread" on the Desktops page).
- **Control** (decisions 008 and 020):

  | Who | Text | Action |
  | --- | --- | --- |
  | the agent | The agent has control | Take control (outline) |
  | you, in this tab | You have control. The desktop follows this tab's size. (Just "You have control." for a desktop that cannot be resized, such as a Windows or macOS VM's.) | Hand back to the agent (filled) |
  | another viewer | Another viewer has control | Take control |
  | the agent, which took it from you (038) | The agent took control | Take control again |
  | nobody, for a moment | Control is changing hands… | none |

  While you hold control, the screen area has a two-pixel inset ring in the
  primary colour, so it is clear which tab sends input. Resizing is
  automatic while you hold control; handing back puts the desktop back to
  the agent's size.
- **Connection**: connecting shows a spinner and "Connecting…" in the
  toolbar; a lost connection shows "Disconnected" with a warning dot, a
  "Reconnect" button, and a notice on the screen area: "The connection to
  the desktop ended. Trying again in 4 s." The relay's refusal, when it
  gives one, is the notice's first line.
- **The box is not running**: the screen area shows a notice with the one
  useful action: "bold-heron is stopped." and a Start button; "bold-heron
  is starting…" with a spinner; "This box has been released." with none.
- Notices are BB's card style, centred on the muted screen area: a line of
  `text-sm`, a muted second line, and at most one button.

## The terminal tab

A thread panel tab per box (`layout: "flush"`), "Terminal: <box>", opened
from a row's "Open terminal" (a quick action and a menu item) while the
box runs. Issue [#51](https://github.com/moonstead/bb-box/issues/51).

```
+------------------------------------------------------------------+
| >_ calm-otter  (green) Connected                                  |
+------------------------------------------------------------------+
| box@calm-otter:~$ ls                                             |
| app  node_modules  package.json  README.md                       |
| box@calm-otter:~$ _                                              |
+------------------------------------------------------------------+
```

- **What it shows**: xterm.js, with BB's canvas and foreground colours
  and its monospace font, over the plugin's own WebSocket (`/terminal`)
  to a shell in the box. The shell's PTY is on BB's server, made by the
  box's transport (`ssh -tt`, `docker exec -it`) under `script`, so
  nothing runs in the box and every box with a command transport has a
  terminal ([src/plugin/terminal.ts](../../src/plugin/terminal.ts),
  [src/transports/terminal.ts](../../src/transports/terminal.ts)).
- **Toolbar**: BB's recessed bar: the terminal glyph, the box's name, the
  state with a status dot: "Connecting…", "Connected", "Ended", or the
  box's state. Nothing else while it works.
- **The shell outlives the tab**. BB remounts a panel tab when a person
  switches tabs. The panel keeps the terminal itself across the switch
  (see "Kept across tab switches" below), and the plugin keeps the shell
  behind it: the tab keeps a session ID per box for the browser tab, as
  the desktop keeps its viewer ID, and a new socket attaches to the same
  shell with the last 256 KiB of output, then its size, so full-screen
  programs redraw. Two tabs on one box never share a shell. A shell with
  no socket for ten minutes ends.
- **Size** follows the tab: the fit addon sizes xterm to the tab, and a
  change in columns or rows goes to the shell once it has settled for
  100 ms.
- **When it ends**, by the shell exiting, the box stopping or going, or
  the plugin restarting, the screen shows "The terminal has ended." with
  the reason the plugin gave ("The shell exited.", "The box was
  released.") and one button, "Start a new shell", also in the toolbar.
  The tab never starts a shell on its own, since that would start one
  without saying so.
- **The box is not running**: as the desktop tab: "calm-otter is
  stopped." with Start; "calm-otter is starting…"; "This box has been
  released." A box whose transport has no shell says "calm-otter has no
  terminal."
- BB's own terminal tab would be better still, with its history and its
  place in BB's terminal list; that is BB request 9 in
  [bb-requests.md](../bb-requests.md).

## Kept across tab switches

BB remounts a panel tab whenever a person switches tabs, and the SDK has
no way to keep one mounted, so a desktop and a terminal used to reconnect
on every switch: a handshake, a blank frame, a shell that had to be
re-attached. The operator asked for them to be kept in memory so switching
back is instant (1 October 2026). The app bundle keeps them
([src/app/kept.ts](../../src/app/kept.ts)):

- Each desktop's noVNC client and canvas, and each terminal's xterm and
  socket, live in a module-level registry keyed by box and viewer or
  session. The session owns an element; a tab puts that element inside
  its screen area on mount and takes it out on unmount, leaving the
  session alive. Switching back re-parents the element: no handshake, no
  blank frame, the same frame and the same scrollback.
- A session rests hidden for ten minutes after its tab goes, then closes.
  A session that ends while hidden (the relay closed it, the shell exited)
  is dropped at once; a hidden desktop does not reconnect on its own.
- A box that stops or is released closes its sessions at once, and the
  tab says so. The plugin reloading drops the bundle and its registry.
- **Control** (008, 022): a hidden tab must not hold a desktop's control
  for ever. When the tab holding control is hidden, the panel starts the
  clock a closed viewer gets, one minute, and then hands control back to
  the agent, unless the person comes back first or someone else took it
  meanwhile. The server's control model is unchanged; this is 008's rule
  applied on the client.
- **Two places at once**: a box can show on the Desktops page and in a
  thread's panel, or in two threads' panels. A second place gets a session
  of its own; it never takes the first's element.
- **What a hidden desktop costs**: its stream keeps flowing from the box's
  VNC server through the relay to a canvas nobody sees, so it costs the
  box and the network what a visible viewer costs, for at most ten
  minutes. noVNC cannot pause a stream, so the choice was keep or close.
  A hidden terminal costs nothing beyond its idle shell; its server-side
  idle clock starts only when the socket closes, so a hidden shell can
  live up to twenty minutes in all.

## The Desktops page

The sidebar entry lists every desktop box, as rows: glyph, name, the OS
and badges, then the state, who has control, and the thread's title, with
"Open" and an "Open thread" action. Your machines (036) come first, under
"Your machines", titled by machine name and without "Open thread"; the
threads' desktops follow under "Threads". Opening shows the same viewer
with a back arrow in the toolbar, at `<thread>/<box>`; a box's terminal
shows the same way at `<thread>/<box>/terminal`, which is how the settings
page opens a machine's terminal, since it has no thread panel to open a
tab in. Empty: "No thread has a desktop box. Make one from a thread's Box
panel."

## Copy

| Where | Text |
| --- | --- |
| plugin description | Computers for BB threads. The plugin shows as "BB Box"; its ID stays bb-box. |
| tab titles | Box; the box's name for its desktop |
| toolbar | New box |
| chooser | Kind · Size · Small · Medium · Large · Custom · Create |
| empty | No boxes yet · A computer for this thread. |
| not set up | BB Box is not set up yet. Set a backend up in its settings and turn it on. · Open BB Box settings |
| states | Starting · Ready in 2.2 s · Joining BB… · BB machine in 5.3 s · Could not join BB · Stopping… · Stopped · Releasing… · Failed · Gone |
| actions | Open desktop · Open desktop in a browser tab · Open terminal · Copy address · Start · Stop · Check now · Release… |
| release | Release bold-heron? · Its disk and everything on it will be deleted. Copy out anything you want to keep first. · Cancel · Release |
| control | The agent has control · You have control. The desktop follows this tab's size. · Another viewer has control · Control is changing hands… · The agent took control · Take control · Take control again · Hand back to the agent |
| connection | Connecting… · Disconnected · Reconnect · The connection to the desktop ended. Trying again in 4 s. |

Agent-facing text is unchanged by the panel; the tools keep saying
`box_acquire` and friends to agents, where those are the right words.

## Seeing it

`scripts/preview/` renders the built panels outside BB with BB's theme and
the fixtures of each state, and `scripts/preview/shoot.mjs` screenshots
every scene with headless Chrome. The screenshots in
[mockups/built](mockups/built/) come from it.

## What the panel needs from the core

- Nothing for the first version: it reads `PanelState`, `BoxView` and
  `KindView` as they are.
- Sizes (028) are in: `KindView.presets`, `defaultPreset` and `largest`;
  `BoxView.size`; `size` on the `acquire` RPC.
- For "Open terminal" (#51): a way to open a BB terminal on the box's
  machine from the panel.
- For "Open bb-box settings": the plugin's settings route, which the panel
  links with BB's `UrlLink`.
