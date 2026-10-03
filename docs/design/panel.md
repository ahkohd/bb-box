# Design: the Box panel and the desktop

How bb-box looks and reads in BB: the Box panel in a thread, the desktop
tab, and the Boxes page. The settings page is in
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
its OS, and what it has reads as badges or, in the New box form, as the
steps that name it (System, Architecture, Type with a Display under it
where a desktop's system offers both windowings and an Image where a
project's image covers the kind, and a GPU under Resources).

| Kind ID | Box row | New box steps |
| --- | --- | --- |
| `linux` | Linux [LXC] | Linux · x86_64 · Server |
| `linux-desktop` | Linux [Desktop] [GPU] [LXC] | Linux · x86_64 · Desktop · 1 GPU |
| `linux-desktop-cpu` | Linux [Desktop] [LXC] | Linux · x86_64 · Desktop · no GPU |
| `linux-arm64`, `linux-arm64-desktop-cpu` | Linux [arm64] [VM], Linux [Desktop] [arm64] [VM] | Linux · arm64 · Server; Linux · arm64 · Desktop |
| `macos`, `macos-desktop` | macOS [VM], macOS [Desktop] [VM] | macOS · arm64 · Server; macOS · arm64 · Desktop |
| `windows-desktop` | Windows [Desktop] [VM] | Windows · x86_64 · Desktop |
| `windows-arm64-desktop` | Windows [Desktop] [arm64] [VM] | Windows · arm64 · Desktop |

Every box row leads with the same glyph, the plugin's cube (the
operator's note of 3 October 2026): the Desktop badge already says the
type, so the glyph does not repeat it. The server and monitor glyphs stay
for the New box Type cards, the Open desktop action and the desktop
view's toolbar, where they name a type or a place rather than a box.

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

In that order. Nothing else is a badge; the backend's name is in the row's
details. Calm, not stacked. A spare ready (032) is no badge either: in the
New box form the provider's row says "1 ready now", in green, so a box of
it is known to come at once. A box claimed from a spare needs nothing
more: its status line says "Ready in 0.1 s".

Badges never squeeze a name. In a row the title line wraps, so badges go
under the name before the name would truncate. The New box form carries
no badges: what a card or a row has sits in words on a line of its own
under its name (the operator's annotation of 1 October 2026: Linux's four
badges had once left one letter of its name).
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
| [o] quiet-fern  Linux [LXC]                            ...  |   row
|     (spinner) Starting · 1.4 s · 2 cores · 4 GiB · 16 GiB   |
|------------------------------------------------------------|
| [o] bold-heron  Linux desktop [GPU] [LXC]        [#] [>_] ... |
|     (green) Ready in 2.2 s · BB machine in 5.3 s ·          |
|     4 cores · 8 GiB · 32 GiB · You have control             |
|     Address     10.200.0.14                                 |   details, when open
|     Backend     Proxmox LXC on pve                          |
|     ...                                                     |
|------------------------------------------------------------|
| [o] calm-otter  Linux [Physical]                [>] ...     |
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
- **Row**: BB's resource row. The box glyph, the cube, on every row, the name
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

Every alert dialog in bb-box (this one, "Stop anyway?", "Remove machine?"
in settings) moves as BB's own dialogs do: a fade with a slight scale from
the centre over 200 ms, the same on close, and no motion at all under
prefers-reduced-motion. shadcn's extra slide (from the left half and the
top 48%) is left out of `components/ui/alert-dialog.tsx`: it was a
Tailwind v3 workaround for the -50% centring, and on v4's separate
`translate` it made the box fly in from the top left (the operator's note
of 3 October 2026, "the way it animates in is weird").

### New box

The plus opens a popover (a bottom sheet on compact viewports) with one
form of sections that narrow each other, the operator's redesign of
1 October 2026: the form asks what the person wants, not which of the
catalogue's kinds they can tell apart. Each section is laid out as the
settings page lays out its sections (the operator's note of 2 October
2026): a title row (`text-xs font-medium`), a dim one-line description
under it where one helps, then the options at full width; no label
column. Sections sit `space-y-5` apart, a section's parts `space-y-3`, cards
`gap-2`, with `px-3 py-2` inside, so the form breathes and a preset's
words are never cut off.

```
+------------------------------------------------------------------+
| System                                                            |
| [ Linux            ] [ macOS            ] [ Windows            ]  |
| [ pve1, pool       ] [ mac-mini         ] [ pve1               ]  |
| Architecture                                                      |
| [ x86_64                       ] [ arm64                       ]  |
| [ 64-bit Intel / AMD           ] [ Not available               ]  |
| Type                                                              |
| [ [=] Server                   ] [ [#] Desktop                 ]  |
| [     Terminal                 ] [     Screen · Terminal · Co… ]  |
|                                                                   |
| Display                                                           |
| [ X11             v ]                                             |
|                                                                   |
| Image                                                             |
| [ rust-tools      v ]                                             |
| Resources                                                         |
| Configure the box's cores, memory, disk and GPU: pick a size, or  |
| Custom to set your own.                                           |
| [ Small      ] [ Medium     ] [ Large      ] [ Custom         ]   |
| [ 2 cores ·… ] [ 4 cores ·… ] [ 8 cores ·… ] [ up to 16 cores ]   |
|                                                                   |
| GPU                                                               |
| [ None            v ]                                             |
| Provider                                                          |
| Where the box goes: the first with room for it, in this order,    |
| unless you choose one.                                            |
|                                                                   |
| Filter [ Kind: All  v ] [ Runs on: Any machine  v ]               |
|                                                                   |
| [ First with room                                              ]  |
| [ Any of the 3 below, in order                                 ]  |
| [ pve1                                                         ]  |
| [ Container · 1 ready now · usually ~2.2 s                     ]  |
| [ SSH host pool                                                ]  |
| [ Physical · 1 free                                            ]  |
| [ docker-host                                                  ]  |
| [ Container · usually ~1.8 s                                   ]  |
| Name                                                              |
| [ Optional: bb-box picks a name like calm-tundra               ]  |
|------------------------------------------------------------------|
| No provider matches these filters.              [ Create box ]    |
+------------------------------------------------------------------+
```

The popover takes the height the window gives it and scrolls inside, so
a short window scrolls the form rather than losing its lower sections
and its button (found on 2 October 2026 on an 805 px window, where the
lower provider rows and Create box sat past the edge, unreachable).

The popover has no heading of its own: the button that opens it is named
"New box", so its first line is the System section (the operator's design
session of 1 October 2026 took the "Add Box" heading off, and gave the
footer the form's own background, not a band). On a compact viewport the
bottom sheet still carries the title "New box".

- **System** is a card per OS on offer, Linux, macOS, Windows in that
  order, with its hosts under the name ("pve1, SSH host pool") or, past
  two, how many providers have it ("3 providers").
- **Architecture** is x86_64 and arm64, always both, with "64-bit Intel /
  AMD" or "64-bit ARM" under them. One no kind of the system has greys out
  and says "Not available"; a click on it does nothing.
- **Type** is Server or Desktop, with what each gives under it:
  "Terminal", or "Screen · Terminal · Computer use". A terminal is access,
  not a type (the operator's note), so it reads under Desktop, not as a
  card of its own. A type the system and architecture lack greys out the
  same way. These are the only glyphs in the form, the server and the
  monitor (`src/app/glyphs.tsx`), drawn in the weight of BB's set.
- **Display** is a detail of a desktop, as a GPU is of its resources, not
  a section of its own, so its title is never bold (the operator's notes
  of 3 October 2026). Where a desktop's system offers both windowings
  (048), a dim sub-label "Display" sits on a line of its own under the
  Type cards, in the GPU sub-label's style, then one menu, X11 or
  Wayland, the names plain and with no description under either (the
  operator took the Wayland note off). It defaults to X11, so nothing
  changes for today's boxes. Like every step it names no kind: the
  windowing maps to a kind ID in `box-form.tsx`.
- **Image** (049) is a detail of the box's kind, in the Display choice's
  shape: where a project's image covers the chosen kind, a dim sub-label
  "Image" under the Type cards, then one menu, this project's image
  first by its name alone ("rust-tools") and chosen at first, which
  says it is this project's, then Standard, then other projects'
  images as "name · Project" ("go-tools · Another project"); plain
  names, no description, and not remembered across forms. The build state (built ahead, or its
  script running as the box starts) stays off the form; the box's row
  and details carry it. Create sends the choice as the acquire RPC's
  `image`, a name or "standard". BB's new-thread inputs offer the same
  list as an Image group after Size, with check marks; outside a
  project nothing is chosen and nothing is sent until the person picks,
  so the provider's own default, the new thread's project's image, still
  applies.
- **No box image** (049): for a Linux box in a project that has no box
  image, the footer's free slot, left of Create box, holds one dim
  link-styled line, "Make a box image for this project", which opens BB's
  new-thread composer with the request filled in. No sentence explains
  it (the operator's note of 3 October 2026); the standing text takes the
  slot when there is one.
- **The sections narrow each other.** Each shows every option, and the
  choice is the nearest that exists: picking Windows, which has no server,
  moves Type to Desktop; picking arm64 where only a server exists moves
  Type to Server; the GPU follows the same way. Nothing is ever chosen
  that no kind is. The form maps the sections to today's kind IDs
  (`src/app/box-form.tsx`, `kindFor`), so the IDs appear nowhere and a new
  kind needs no panel change. Descriptions stay where agents read them, in
  `box_list` and the skill.
- **Resources** comes before Provider (the operator's note of 2 October
  2026): the size and the GPU narrow what the providers below can hold,
  and later the rows can say which have room for that size. It says
  what to do, "Configure the box's cores, memory, disk
  and GPU: pick a size, or Custom to set your own." ("and GPU" only where
  a GPU is a choice), then the kind's presets (028), Small, Medium and
  Large, each with its cores and memory under it, and Custom with "up to N
  cores"; the kind's default preset is chosen at first. Custom shows three
  fields, cores, memory in GiB and disk in GiB, each with "up to" the
  kind's largest, starting from the preset the person was looking at; a
  field left empty takes the default preset's value, and an empty disk
  keeps the base disk. A GPU is a resource: where a desktop's system has
  both a GPU desktop and a CPU one, a dim sub-label "GPU" on a line of
  its own under the presets, then one menu, None or 1 GPU (more counts
  can join it later), as the operator asked on 2 October 2026. The form
  sends a preset by name, or the custom fields, and nothing for the
  default.
- **Provider** is where the box goes (044). Under the description, a row
  of its own holds a dim "Filter", at the menus' text size, and two
  compact menus, their labels inside the trigger ("Kind: All", "Runs on:
  Any machine"), since they filter the list rather than choose from it,
  the three together at the left; on a narrow pane they wrap. The row
  sits the section's usual space below the description and above the
  list (the operator's notes of 2 October 2026: chips had read as a
  second kind of control, the menus had then sat on the title row, too
  tight, a left-aligned row in a small size read as a third kind of
  thing, and a right-aligned one, once the label had the menus' size,
  sat apart from the list it filters). The GPU sub-label under Resources
  is the same dim label at the same size. **Kind**: All, Container (LXC or Docker), VM,
  Physical; an option no provider of the kind makes is there but cannot
  be chosen. **Runs on**: Any machine, a Mac, a Linux machine, a Windows
  PC, listing the machines the providers run on (`OfferView.hostOs`);
  Physical hides it, since a pool machine runs on nothing. A provider that
  does not know its machine's OS yet (a Docker machine whose daemon has
  not answered) stays under every Runs on choice, so it does not vanish.
  Then a radiogroup, Provider: "First with room", chosen at first, with
  "Any of the N below, in order" under it; then one row per provider, its
  name at full strength and its words dim: what the boxes are, spares
  "ready now" in green (a status, not a brand), free machines, and the
  usual cold start ("usually ~3.1 s", the median of the kind's last five
  on that backend). Rows carry no provider mark and no brand colour (the
  operator's note of 2 October 2026; #292's colours stay out of the form).
  A row's name is its host ("pve1"), "2 Macs" or "3 hosts" for several,
  the backend's label for a pool, and "an unnamed machine" for a Docker
  machine BB has not named: a row never shows a host ID (the operator's
  rule). A row is one card: its hover and
  chosen backgrounds span the whole card, and a small (i), the size of
  the row's dim line on a 24 px hit area, sits inside it at the right,
  shown while the pointer is over the row, the row or the (i) has
  keyboard focus, or its profile is open, its space kept otherwise so
  nothing shifts; a touch screen, with no hover, shows it on the chosen
  row (the operator's notes of 2 October 2026). The pointer resting on the (i) for about 300 ms opens the
  provider's profile as a preview, which the pointer may move into and
  leaving closes after a short grace; a click or the keyboard (Tab, then
  Enter) opens it and keeps it until Escape or a click away, for touch and
  screen readers. The profile is a popover in the form's rhythm: the
  provider's name and its technology (the driver's description) as title
  and dim line, then plain rows, Runs on (its hosts and what they run),
  Makes (the kinds it offers and what the boxes are), Room (each host's
  limits in words, "memory 12 of 64 GiB, 4 GiB kept back", and the
  provider's own words when none is left), Usually (the kind's last cold
  starts on it, with spares ready now) and Status (Ready, Needs attention
  or Needs setting up, the doctor's summary, boxes on it, when it was
  checked). The form reads every listed provider's profile in the
  background once it has painted, all at once, each with one capacity
  call to the provider, and keeps them while it stays open, so the (i)
  opens filled (the operator's note of 2 October 2026: it had read
  "Looking…" on hover); one still on its way says "Looking…", and one
  that failed is asked again when its (i) opens. Nothing is read while
  the form is closed, and never on a panel load (the operator's
  artboard). One provider is no choice: its row stands alone, checked, and
  the request sends no `on`. The chosen row's backend ID goes as `on`; a
  filter that leaves one provider sends that one too. First with room
  among several that a filter left sends them as a list, and the first
  with room among them takes the box, in acquire order (044). Filters
  that leave none leave the list empty, say so in the footer, and disable
  the button. The choice and the filters are not remembered: another
  type, or closing the form, puts them back.
- **Name** appears for Add machine only (036): optional, as its
  description says, checked as the person types, with what is wrong under
  the field.
- **The footer** holds the one button, worded for what it does, "Create
  box" in the panel and "Add machine" in settings, above a hairline on the
  form's own background. Beside it sits whatever stands in the way: a
  refusal (no room, the thread's limit, a size above the largest) in
  destructive text with the backend's words, the popover staying open so
  the person can pick another size or provider; or "No provider matches
  these filters." in muted text. There is no summary line and no access
  chips: every choice shows in its section, and the access a desktop
  gives reads under Type (the operator's note of 2 October 2026). Enter
  does the same as the button. The popover closes, and the new row
  appears with "Starting".
- The form remembers the last kind (as the sections that name it) and
  size in the browser, keyed by plugin ID, so the next box is two clicks.
- Keyboard: each section's options are a radiogroup; the arrow keys move
  within it, and Tab moves between the sections, the menus, the provider
  choice, Resources, Name and the button.
- The form's data comes with each kind (`KindView.offers`, `computerUse`):
  the registry keeps the last five cold starts of each kind on each
  backend and counts spares ready per backend, a real backend gives its
  free machines from its last survey, and each backend says what its
  machine runs (`Backend.hostOs`: Linux for a Proxmox node and a pool
  machine, a Mac for Tart, and for Docker what the machine says).

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
  thread" on the Boxes page).
- **Control** (decisions 008 and 020):

  | Who | Text | Action |
  | --- | --- | --- |
  | the agent | The agent has control | Take control (outline) |
  | you, in this tab | You have control. The desktop follows this tab's size. (Just "You have control." for a desktop that cannot be resized, such as a Windows or macOS VM's.) | Hand back to the agent (filled) |
  | another viewer | Another viewer has control | Take control |
  | the agent, which took it from you (038) | The agent took control | Take control again |
  | nobody, for a moment | Control is changing hands… | none |

**Size.** With control, the desktop follows the tab's size: the viewer
asks the box for a new size once the pane's size has held for 250 ms
(`SETTLE_MS`), and not while it moves. noVNC 1.7 would ask on the first
frame of a change, with no wait, and the box's queue set that size
before the final one, so a maximise landed in two steps (the Windows box
of 2 October 2026); now a maximise, a restore and a window drag each land
in one step. The opening fit is asked for at connect, before any move,
and the first frame does not wait for it. The viewer measures its screen
in whole pixels, as noVNC floors the size it asks for: with fractional
pixels the two never matched after a resize, so a pane of 851.5 px kept
a one-pixel request outstanding, and a maximise that met it waited for
that request's round trip (#353).

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
- **Two places at once**: a box can show on the Boxes page and in a
  thread's panel, or in two threads' panels. A second place gets a session
  of its own; it never takes the first's element.
- **What a hidden desktop costs**: its stream keeps flowing from the box's
  VNC server through the relay to a canvas nobody sees, so it costs the
  box and the network what a visible viewer costs, for at most ten
  minutes. noVNC cannot pause a stream, so the choice was keep or close.
  A hidden terminal costs nothing beyond its idle shell; its server-side
  idle clock starts only when the socket closes, so a hidden shell can
  live up to twenty minutes in all.

## The Boxes page

The sidebar entry, "Boxes", lists every box across threads, servers as
well as desktops, as rows: the box glyph (the cube, on every row), name,
the OS and badges, then the state, who has control for a
desktop, and the thread's title. Its icon is BB's branding cube, which
suits a page of boxes; the plugin names no icon of its own, since none
would resolve (the plugin's id is not "bb-box"), so BB draws the cube.

Each row carries the actions the box can take, as quick icon buttons:
"Open desktop" for a ready desktop box, "Open terminal" once the box has
one, "Open desktop in a browser tab" where a desktop exists, and "Open
thread" for a thread's box. Your machines (036) come first, under "Your
machines", titled by machine name and without "Open thread"; the threads'
boxes follow under "Threads". Opening a desktop shows the same viewer with
a back arrow in the toolbar, at `<thread>/<box>`; a box's terminal shows
the same way at `<thread>/<box>/terminal`, which is how the settings page
opens a machine's terminal, since it has no thread panel to open a tab in.
Empty: "No boxes" — "No thread has a box, and you have no machines. Make
one from a thread's Box panel."

## Copy

| Where | Text |
| --- | --- |
| plugin description | Computers for BB threads. The plugin shows as "BB Box"; its ID stays bb-box. |
| tab titles | Box; the box's name for its desktop |
| toolbar | New box |
| chooser | System · Architecture · Type · Server · Desktop · Not available · Provider · Filter · Kind · All · Container · VM · Physical · Runs on · Any machine · First with room · Resources · Small · Medium · Large · Custom · GPU · None · 1 GPU · Create box · Add machine · No provider matches these filters. |
| provider profile | About <provider> · Runs on · Makes · Room · Usually · Status · Looking… · Not known: the provider did not answer. |
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
