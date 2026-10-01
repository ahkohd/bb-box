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

Kinds follow the operator's decision of 1 October 2026: the plain box has no
qualifier and only desktops say so.

| Kind ID | Shown as | Icon |
| --- | --- | --- |
| `linux` | Linux | server |
| `linux-docker` | Linux with Docker | server |
| `linux-desktop` | Linux desktop | monitor |
| `linux-desktop-cpu` | Linux desktop | monitor |
| later `macos`, `macos-desktop`, `windows-desktop` | macOS, macOS desktop, Windows desktop | server, monitor |

The panel shows `kindLabel` from the backend; the IDs appear nowhere. Two
kinds may share a label: the GPU desktop and the CPU desktop are both
"Linux desktop", and badges tell them apart (the operator's annotation of
1 October 2026, which removed "(no GPU)" from the label).

### Badges

BB's chip (its machine picker's and settings sections' small bordered word)
sits after a kind's or a box's label, in the Kinds rows, the box rows, the
New box options and the desktop lists:

- **GPU** where the kind takes one. A box of a GPU kind whose display fell
  back to the CPU says "Display on the CPU" in its status line, in warning
  text; otherwise the status line does not repeat the badge.
- **What the box is**, one word from its backend's driver: LXC, Docker, VM
  or Physical. A kind on offer from several backends shows each once.
- **Ready now**, in the New box options only, last, on a kind with a spare
  box ready (032), so a box of it comes at once. A box claimed from a spare
  needs nothing more: its status line says "Ready in 0.1 s".

Nothing else is a badge: "desktop" and "with Docker" are in the label, and
the backend's name is in the row's details. Calm, not stacked.

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
| [=] calm-otter  Linux with Docker [Physical]    [>] ...     |
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
| BB machine | its name and whether it is connected; "off" when enrolment is off; the error when it failed |
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
small form:

```
Kind:
  (o) [=] Linux
          [LXC] [Physical] [Docker] [Ready now]
  ( ) [#] Linux desktop
          [GPU] [LXC]
  ( ) [#] Linux desktop
          [LXC] [Docker]
Size:
  [ Small ] [ Medium ] [ Large ] [ Custom ]
  2 cores · 4 GiB memory · base disk
[ Create ]
```

The popover has no heading of its own: the button that opens it is named
"New box", so its first line is "Kind:" (the operator's annotation of
1 October 2026). "Kind:" and "Size:" are the section labels, in
`text-xs font-medium text-foreground`, so they stand above their options
(a second annotation the same day). On a compact viewport the bottom sheet
still carries the title "New box".

- **Kind** is a list of options, each its glyph, its label and, on a line
  of its own under the label, its badges, and nothing more (the operator found the descriptions noise, 1 October 2026;
  they stay where agents read them, in `box_list` and the skill), chosen
  with a click or the arrow keys; the chosen one is
  highlighted with a check. The list comes from the kinds on offer, so a
  new backend's kinds need no panel change.
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

### Empty states

- **No boxes**: BB's dashed empty panel: "No boxes yet", then "A computer
  for this thread." The operator asked for that line to stay this simple
  (1 October 2026). The toolbar's plus is the action; the panel does not
  repeat it.
- **No backend on**: "BB Box is not set up yet. Turn on a backend in its
  settings." with an "Open BB Box settings" button that goes
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
  | you, in this tab | You have control. The desktop follows this tab's size. | Hand back to the agent (filled) |
  | another viewer | Another viewer has control | Take control |
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
  switches tabs. The plugin keeps the shell; the tab keeps a session ID
  per box for the browser tab, as the desktop keeps its viewer ID, and
  attaches to the same shell with the last 256 KiB of output, then its
  size, so full-screen programs redraw. Two tabs on one box never share a
  shell. A shell with no tab for ten minutes ends.
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

## The Desktops page

The sidebar entry lists every desktop box in every thread, as rows: glyph,
name, kind, then the state, who has control, and the thread's title, with
"Open" and a menu with "Open thread". Opening shows the same viewer with a
back arrow in the toolbar. Empty: "No thread has a desktop box. Make one
from a thread's Box panel."

## Copy

| Where | Text |
| --- | --- |
| plugin description | Computers for BB threads. The plugin shows as "BB Box"; its ID stays bb-box. |
| tab titles | Box; the box's name for its desktop |
| toolbar | New box |
| chooser | Kind: · Size: · Small · Medium · Large · Custom · Create |
| empty | No boxes yet · A computer for this thread. |
| not set up | BB Box is not set up yet. Turn on a backend in its settings. · Open BB Box settings |
| states | Starting · Ready in 2.2 s · Joining BB… · BB machine in 5.3 s · Could not join BB · Stopping… · Stopped · Releasing… · Failed · Gone |
| actions | Open desktop · Open desktop in a browser tab · Open terminal · Copy address · Start · Stop · Check now · Release… |
| release | Release bold-heron? · Its disk and everything on it will be deleted. Copy out anything you want to keep first. · Cancel · Release |
| control | The agent has control · You have control. The desktop follows this tab's size. · Another viewer has control · Control is changing hands… · Take control · Hand back to the agent |
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
