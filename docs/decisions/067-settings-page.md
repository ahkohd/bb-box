# 067: The settings page is an overview, with a page one step in for each backend, kind and option

Status: proposed, 29 October 2026, revised the same day after two independent reviews (see [What changed after the reviews](#what-changed-after-the-reviews)). For the owner's review. Nothing is built.

The prototype is [067-settings-page/prototype.html](067-settings-page/prototype.html):
one file, opened in any browser, made from bb-box's own components. Its
source is in [067-settings-page/prototype](067-settings-page/prototype/).
How to click through it is under [The prototype](#the-prototype).

## Context

The owner, on the page in production: "I think the settings page is really
bad, both the UX and the UI. And we should take our time to design a very
good settings page, befitting of this project."

The page is BB's Settings > BB Box. BB draws its header: the plugin's icon,
name, description and on-off switch. bb-box draws everything below it, as
one `settingsSection` (`src/app/settings.tsx` and its `settings-*.tsx`
siblings). It reads `config.get` and writes the whole configuration with
`config.apply` against the revision it read (decision 029). The design
before this one is [docs/design/settings.md](../design/settings.md).

### Who uses the page, and for what

One person uses it: the operator of a BB install, who is often the only
user. Today that is the owner, every day. After bb-box is open-sourced it is
also a newcomer setting bb-box up for the first time. Agents do not use the
page; they use `bb box config` and `bb box image`, so the page must show
what they set.

The tasks, most frequent first. The order is estimated from the decisions'
history and the owner's notes, not measured.

| # | Task | How often |
| --- | --- | --- |
| 1 | See whether everything works, and why a box could not be made | Daily, and after each failure in a thread |
| 2 | Turn a backend, a kind or a Docker machine on or off for a while, such as a paid cloud backend | Weekly |
| 3 | Tune a kind: its sizes, warm boxes and spares | Weekly while tuning |
| 4 | Change a backend: a new template after a rebuild, a new Mac, a new token | Monthly |
| 5 | Rebuild images, or see which are due | Monthly |
| 6 | Set preferences once: default kind, boxes per thread, video, Monitor, tailnet, files for every box | Once, then rarely |
| 7 | Set bb-box up for the first time, or add a backend | Once per backend |
| 8 | Expert settings: device streaming, test device, export and import of the configuration | Rarely |

### What is wrong today

Measured in the owner's browser on 29 October 2026, looking only, at a
viewport of 1440 by 1000. The screenshots are cropped to bb-box's part of
the page, and machine, host and thread names are replaced with generic
ones.

1. One long page with no shape. Ten sections of equal weight, 4,242 px
   tall, about four and a half screens. The most frequent task, "does it
   all work?", has no answer at a glance: nine backend rows each say "Ready
   … checked 6 hours ago", and one in trouble would be one amber dot among
   them. ([top of the page](067-settings-page/today/1-top.png))
2. Machines are on it twice. The Machines section repeats the Boxes
   page's Machines tab, with the same rows and actions, and it comes first,
   above the configuration.
3. "Set up" on every backend, working ones included. It opens a form
   inside the list: 22 fields and a 25-line check report push the rest of
   the page three screens down, and the Save button sits far from the row
   it belongs to. ([setup form](067-settings-page/today/5-setup.png),
   [check report](067-settings-page/today/5b-doctor.png))
4. The check report is hard to read. Each check's name and detail run
   together ("Node Boxes run on pve-1"), and every passed check is shown in
   full, so a failure has to be found among twenty green ticks.
5. Kinds are misnamed and dense. A kind's row is named by its OS, so
   the Android emulator kind reads "Linux" and the iOS Simulator kind reads
   "macOS". Rows list every backend in a sentence ("From Proxmox LXC and SSH
   host pool and Docker and Proxmox QEMU and Docker and microsandbox and
   Hetzner Cloud and Namespace") and every size in another. Kind switches
   sit on the left, backend switches on the right.
   ([kinds](067-settings-page/today/3-kinds.png),
   [more kinds](067-settings-page/today/3b-kinds.png))
6. Docker on BB machines lists every machine. Six of its nine rows say
   "No Docker", and it is a section apart from the Docker backends it
   makes. ([Docker on BB machines](067-settings-page/today/2-docker-machines.png))
7. Four ways to save. Switches save at once. A backend's form and a
   kind's editor save with their own Save. The tailnet has a Save button of
   its own. Boxes per thread and the refresh interval save, silently, when
   the field loses focus. Nothing says "Saved".
   ([general](067-settings-page/today/4-general.png),
   [Monitor and tailnet](067-settings-page/today/4b-monitor-tailnet.png))
8. "General" is a drawer. The default kind, the thread limit,
   enrolment, video and the nightly rebuild share one card.
9. Settings with no place. The test device, the iOS encoder, the
   encoder ledger and projects' images are in the configuration but not on
   the page; only `bb box config` reaches them. A backend cannot be renamed
   or removed from the page.
10. A change made elsewhere shows as a banner at the top of the page,
    far from the form, and asks the person to make their change again.
11. No way to find a setting. The owner's configuration holds over 300
    values across 9 backends and 12 kinds. BB's own search does not reach
    them.

### What BB lets a plugin do here

A plugin's `settingsSection` gets no props and no route of its own: it is
rendered below BB's header on the one page `/settings/plugins/bb-box`
(Plugin SDK 0.6.15, and still so in 0.6.94). Anything deeper than one page
is the plugin's own state. A `navPanel`, such as the Boxes page, owns a
route and its sub-paths.

Above the plugin's section BB draws, on every view of the page: its
"Plugin details" link, the plugin's icon, name, description and on-off
switch, any BB notice (such as "Machines cannot reach this bb yet"), and a
"Configuration" heading. The page cannot hide or replace them.

### Unit 0: the URL hash in a real BB

Both reviews asked for this before anything else. It was run on 29 October
2026 in a separate BB in a box: BB 0.48.0 from a fresh `npx bb-app` with
no account and its own data folder, bb-box installed from main
(`aaee83ca`), and a small probe plugin whose settings section reported the
hash, how many times it had mounted, and its own state. A script drove it
in headless Chromium. Each result is the URL and the probe's values after
the step. The probe's settings section and the script are in
[067-settings-page/unit-0](067-settings-page/unit-0/app.tsx).

| Step | Result |
| --- | --- |
| Open `/settings/plugins/hashprobe#backend/x` directly | The hash is kept; the section mounts once and reads it |
| `history.pushState` with BB's router state kept, or with none, and `location.hash = …` | The URL changes; the section is not remounted and keeps its state |
| Browser back and forward over those entries | Each returns to the right hash, inside the page, without a remount |
| Reload | The hash is kept; the section starts afresh, as expected |
| Leave by BB's sidebar, then come back with back | The hash is back; the section remounts, and module-level memory survives |
| BB's `UrlLink` to the same page with another hash | The URL changes, but no `hashchange` or `popstate` reaches the section |
| `UrlLink` to bb-box's settings with a hash, from another page | The hash is kept and read on mount |

So the hash works for deep links, back, forward and reload, and no
fallback is needed. Two rules follow: the page moves between its own views
with `pushState` and its own listener, never with `UrlLink`; and anything
that must outlive the section, such as drafts, is kept outside React state.

## Decision

### 1. One page in BB's Settings: an overview, and a page one step in for everything else

The page stays where BB puts plugin settings, under BB's own chrome. It is
an overview with one page one step in for each backend, each kind, each
group of options, Add backend, and setting up a backend. Every setting is
at most one step from the overview, and nothing is on the page twice.

Each view has a hash, such as `#backend/proxmox-lxc`, `#kind/linux`,
`#option/monitor`, `#add` or `#setup/tart`. The Box panel, the Boxes page
and the Monitor link straight to a view. The browser's back and forward
buttons walk the views.

Below BB's "Configuration" heading, every inner view starts with one row:
where you are ("BB Box settings › Proxmox LXC on pve-1", the first part a
link to the overview) and Find a setting. When the person came from
another inner view, such as from a kind to one of its backends, the row
also offers "Back to Linux desktop (GPU)", and back returns there. The
overview has Find alone, at full width.

On opening a view, the page moves focus to its heading. Going back puts
focus on the row the person opened, and the scroll position where it was.
After a new backend is saved, the setup view is replaced in history by the
backend's page, so back never returns to an empty setup form.
([overview](067-settings-page/new/01-overview.png))

### 2. The overview, in order

| Part | At a glance | One step in |
| --- | --- | --- |
| Find a setting | A field. Typing lists matching settings with where each lives and its value | The setting's page, scrolled to it, focused and highlighted |
| Status | One honest line: how many backends are ready, how many are off or not checked since they changed, the kinds on offer, and how old the checks are, with Check all. With anything wrong, a callout lists each thing with its fix in words and Open | The page that fixes it |
| Backends | One row each: icon, name, host chip, one state line, an "Unsaved changes" chip when a draft is waiting, and the switch | The backend's page |
| Kinds | One line each in three groups (Linux; macOS and iOS; Windows and Android): name and chips, default size, how many backends make it, warm and spare counts, and the switch | The kind's page |
| Options | One row each, with its value: Boxes, Images, Devices, Network, Monitor (with its switch on the row), Configuration, and Your machines, which opens the Boxes page on its Machines tab | The option's page |

The status line is never more certain than the checks. It says "All 8
backends passed their last check · checked 6 hours ago", not "ready", when
the checks are older than an hour, and Check all becomes the main button.
One backend checked a minute ago does not freshen the rest: the line gives
the range ("checked between 4 min and 6 hours ago").

The callout covers everything that can stop a box, not only failed checks:
backends that fail or need attention, backends saved but not finished, the
default kind turned off, kinds that backends that are on cannot make now,
warm pools short for want of room, images whose rebuild failed, and Docker
on a BB machine that answers but cannot run containers.
([with problems](067-settings-page/new/23-problems.png))

Kinds that are off fold into "2 kinds off", and kinds no backend you have
makes fold, quietly and without amber, into "3 kinds no backend you have
makes". A kind switched off on this visit stays where it is, dimmed, until
the person leaves the page. ([a kind just turned off](067-settings-page/new/02-kind-off-stays.png))

Machines leave the settings page: the Boxes page's Machines tab already
does all they did. Docker on BB machines joins Backends: a machine in use
is a Docker row with a "BB machine" chip and its image build on its state
line; machines that could host boxes are offered under Add backend and in
one line under the list.

### 3. Each page

A backend's page ([page](067-settings-page/new/12-restored-after-reload.png)):

- Header: icon, name, host chip, description, "Takes new boxes" switch, and
  a menu: Rename…, Copy saved settings as JSON, Open the setup guide, and
  Remove backend…. Under it: "Saved changes reach new boxes; boxes already
  made keep theirs", and the saving rule (section 4).
- Health: the same honest state as its row. "Last check passed · 6 hours
  ago, so it may have changed since"; "Not checked since it changed", when
  its settings changed after the last check; "Not finished" when saved off
  with problems. Failed checks and warnings come first, each with its fix.
  Passed checks fold. With unsaved changes the button says "Check with my
  changes", and the card says it checked the unsaved form.
- In use: boxes now; the kinds it makes, each a link; warm boxes, with
  "0 of 1 ready: no room" where the pool is short.
- The driver's fields, in cards: Connection, Credentials, Boxes, then
  Shared iOS hosts and Advanced, both folded with a summary of what is set.
  A card opens by itself when it holds a problem, a conflict, an edit or
  the setting Find opened.
- Each field shows the first sentence of its help, with More for the rest.
  A blank field shows the value it takes and from where: "Default: 4096",
  "From Proxmox LXC: https://…", or for a Mac "Estimate for this Mac: 10
  cores". A template or image field that turns a kind off when empty has an
  Offer checkbox instead: unticked, it is saved as off, never as "use the
  default".
- Tart's Macs: one row each with its own switch, which acts at once. A row
  opens to its address, user, host keys and "Its own shared iOS host size",
  with the effective value beside each blank field. Add Mac adds a staged
  Mac, saved with the form; Remove asks, with what follows (section 4).

A kind's page ([page](067-settings-page/new/24-kind.png)):

- Header: name and chips, description, Make default, and the "Offered to
  threads" switch. The default kind's switch is disabled everywhere, with
  "The default kind stays on. Choose another default to turn it off" and a
  link to the choice. If the configuration has the default kind off (an
  agent can do it), the page and Status say so as a problem.
- Sizes: Small, Medium, Large and Largest by cores, memory and disk, with
  the default chosen in its column. On a narrow screen each size becomes a
  block of three labelled fields with their units.
  ([narrow, with an error](067-settings-page/new/25-narrow-kind.png))
- Where it runs: each backend that can make it, in the order a new box
  tries them, with how its boxes are made, whether it makes it now, its
  warm count, and any shortfall with its reason.
- Spare boxes: the count, and how many are ready or being made. On the
  device kinds it says spares are off by default and why.

Options' pages:

| Page | Holds |
| --- | --- |
| Boxes | Default kind (a menu that acts at once); boxes per thread (a field); boxes join BB as machines and Linux desktops as video (switches); Files for every box |
| Images | Rebuild each night; the standard images, each with its age, why it is due, and what last night's run did to it (rebuilt, waited for room, failed with why, skipped, not started); Rebuild what is due with its progress; projects' images with their kinds, projects, source, script, check script, when they are built ahead, and Remove… |
| Devices | iOS video encoding; share each Mac's encoder fairly; links to the shared iOS hosts on each backend and to the spares of each device kind; the test device |
| Network | The tailnet: whether machines join (two radio choices), tags, OAuth client ID and secret, saved together |
| Monitor | Machine status (also on its overview row), refresh every, background monitoring, pressure notifications; after the switch changes, "The sidebar's machine status changes when BB next loads" with Reload BB now. The Monitor panel links to this page |
| Configuration | The revision and what happens when two people save; Export (no secret in it, and which secrets must be pasted again to set BB Box up from it); Import, which checks a pasted file and lists what it changes against the current revision before Apply; the copy of BB's earlier settings and Remove copy…; the `bb box config` commands |

Add backend ([page](067-settings-page/new/18-first-run-resume.png) shows
its entry): Docker on your BB machines first, as it is ready now, with
machines whose Docker fails shown as "Cannot host boxes" with the reason
and Check again; then every backend, grouped by where boxes run, each
saying what it makes and what it needs. A backend that cannot be added
twice says "Added: open it".

Setting up a backend ([page](067-settings-page/new/16-setup-problems.png)):
the backend's form in four numbered steps: 1, Prepare: the guide and its
scripts in the order it runs them; 2, Connect: connection, credentials and
Macs; 3, Choose what it makes, with "It will make …" kept up to date as
Offer boxes change; 4, Check it: "Runs all of Proxmox LXC's checks against
this form, as it will be saved, up to 30 s. Nothing is saved." The bar
offers Save and turn on, Save, keep it off, and Discard and go back.
Saving lands on the backend's page. A backend saved off with problems
shows as "Not finished", with what is missing, on its row, in Status, and
in first run. ([not finished](067-settings-page/new/17-not-finished.png))

### 4. Saving: one rule, and a merge that never loses anyone's change

The rule, shown under each page header that has a form: switches act at
once; fields, checkboxes and choices wait for Save.

- A switch is an independent decision and acts at once: a backend or a
  kind on or off, a saved Mac on or off, an option such as video or
  background monitoring. A menu that stands alone acts at once too: the
  default kind, iOS video encoding, when a project's image is built ahead.
  Each shows "Saved" beside it for a moment. A refusal puts it back and
  says why under its row.
- Everything that belongs together is a form with one explicit Save:
  a backend's fields, a kind's sizes with its default size, warm counts
  and spares, the tailnet's choice with its tags and credentials, a new
  Mac with its fields and its "Takes boxes" checkbox, a file's path with
  its content. In a form, on-or-off values are checkboxes and choices are
  radio buttons, never switches, so a switch always means "at once".
  ([the tailnet waits](067-settings-page/new/33-tailnet-staged.png))
- The first change in a form brings up a bar: "2 changes to Proxmox LXC on
  pve-1 not saved", with Discard and Save, and Check on a backend's page.
  Enter in a field saves. A changed field has a "Changed" chip. Discard
  puts back the saved values of the fields changed here; switches already
  turned stay as they are. In setting up a backend Enter does nothing,
  as whether to turn it on is the person's choice.
- Removing something asks first and says what follows: a backend (its
  secrets are deleted and cannot be got back, its warm boxes go, there is
  no undo, and it is refused while it has boxes); a Mac (staged until
  Save, refused while it has boxes); a file; a project's image; the copy
  of BB's earlier settings. ([remove a backend](067-settings-page/new/32-remove-confirm.png))

The merge. Agents change the configuration while the page is open, with
`bb box config apply` and `bb box image set`, so the page must never send
back a value it read before someone else changed it.

- A draft is a set of edits, each a setting's path, such as
  `backends/proxmox-lxc/fields/node`, with the value typed and the stored
  value it started from. A "part" is the set of paths the form writes, not
  a section of the document: a kind's form writes its sizes and each
  backend's warm count for it.
- The page reloads the configuration on bb-box's change signal, as today.
  A field nobody edited here simply shows the new stored value. A field
  edited here that also changed elsewhere is a conflict, shown on its row
  at once, not at Save: "Changed elsewhere to 8192 while you edited", with
  Use theirs and Keep mine. Each acts on that field only; every other edit
  stays. Save waits until each conflict is chosen.
  ([conflict on the row](067-settings-page/new/04-conflict-inline.png))
- Secrets are never compared by value, which the page never has. The
  server gives each secret an opaque change version, the revision that
  last set it, with `{ set, version }`. A secret replaced here whose version
  moved since the edit began is a conflict: "Replaced elsewhere while you
  edited, at revision 216. Saving yours replaces that one", with Keep the
  saved one and Keep mine. ([secret conflict](067-settings-page/new/05-secret-conflict.png))
- Save sends the edits applied to the latest configuration the page has,
  with that configuration's revision. When the server says someone saved
  first, the page reloads, checks the edits against the new values, and
  either saves on the new revision ("Saved, on top of a change made
  elsewhere") or stops with the conflicts on their rows. It never retries
  with a revision it has not checked, and stops after three tries.
- A refusal keeps the draft: "Not saved: … Your changes are still here",
  with Save again. ([refused](067-settings-page/new/09-refused.png))
- An unknown outcome is not called a failure. `config.apply` stores the
  document before it replies, so a lost reply may hide a save. The bar
  says "Save not confirmed: BB Box did not reply. Checking whether it was
  saved…", reloads, and compares each edit with what is stored, and for a
  secret, its version. Then it says "Saved. The reply was lost, so BB Box
  checked: your changes are there", or "Save not confirmed, and your
  changes are not in the configuration. Nothing is lost: save again".
  ([not confirmed](067-settings-page/new/07-not-confirmed.png),
  [reconciled](067-settings-page/new/08-reconciled.png))
- "Saved" belongs to what was sent. Typing during a save stays a change:
  "Saved. Your newer change is not saved yet."
  ([saved, with newer typing](067-settings-page/new/10-saved-earlier-change.png))

### 5. Drafts survive everything

A draft lives outside the page's components, so it outlives them.

- Unit 0 showed the section remounts when the person leaves by BB's
  sidebar, and that module memory survives. Drafts are kept there, and
  each part's non-secret edits are also kept in `sessionStorage`, so a
  reload keeps them too.
- Secrets and file contents are kept in memory only: they never go into
  browser storage, which other plugins on the page can read. After a
  reload the page says so: "Your unsaved changes to Proxmox LXC on pve-1
  are back: 1 change. For safety the API token secret you pasted was not
  kept; paste it again", with Keep them and Discard them.
  ([restored after a reload](067-settings-page/new/12-restored-after-reload.png))
- Leaving a page with a draft does not ask: the draft waits, and the
  overview marks its row "Unsaved changes".
  ([unsaved chip](067-settings-page/new/11-unsaved-chip.png)) Closing or
  reloading the tab with a draft asks first, through the browser's own
  warning.
- The same holds for every editor: a backend, its setup, a kind, Boxes,
  Monitor, the tailnet, per-Mac fields, a file being added or replaced,
  and an import being checked. A draft is cleared only by a confirmed save
  or by Discard. A refused file save keeps the editor open with its text.
  ([file kept](067-settings-page/new/13-file-kept.png))

### 6. First run stays until something works

First run shows until a backend that is on makes at least one kind, not
merely until a backend exists. It keeps today's guidance from
`first-run.tsx`, word for word where it is good:

- Docker on BB's server is usable: "Use Docker on this machine", with the
  build's progress, then "Docker on this machine is ready", what to do
  next, and Status saying "Docker on this machine is ready" rather than
  "All 1 backend ready".
- Docker is missing: the command to install it, Check again, and a BB
  machine that has Docker, when there is one.
  ([missing](067-settings-page/new/19-docker-missing.png))
- Docker is there but BB's user cannot use it: the command to add it to
  the docker group, the restart line, and Check again.
  ([no access](067-settings-page/new/20-docker-permission.png))
- Too little disk, a failed build, or machine access BB cannot reach: today's
  words, their fix and Check again or Try again.
- A backend saved but not finished: "Finish setting up Proxmox LXC", with
  what is missing, stays in the card.
  ([resume](067-settings-page/new/18-first-run-resume.png))
- Kinds and Options fold under "Sizes and options … for later". No amber
  "Not offered" appears for kinds no backend makes.
  ([first run](067-settings-page/new/14-first-run.png))

### 7. States of each part

| State | A backend's row and page | A kind | Status |
| --- | --- | --- | --- |
| Off | "Off · takes no new boxes" | "Off: no new boxes", dimmed | Counted as off |
| Not finished | "Not finished" and what is missing | — | Listed, with Open |
| Not checked yet | "Not checked yet" | — | Counted |
| Not checked since it changed | "Not checked since it changed": its settings changed after the last check; the check is bound to the configuration it tested | — | Counted, and Check all becomes the main button |
| Checking | "Checking…" with BB's spinner, up to 30 s | — | "Checking 8 backends, up to 30 s each, side by side…" |
| Last check passed, over an hour ago | "Last check passed · 6 hours ago" | — | "passed their last check", with the range of ages |
| Ready | "Ready", checked within the hour | Its summary | "All 8 backends ready" |
| Needs attention | Amber, with the warning | — | Listed with its fix |
| Not working | Red, with the failure | "Not offered now: its backends cannot make it" | Listed with its fix |
| Warm pool short | "0 of 1 ready: no room" in In use | On the kind's page with the reason | Listed |
| Building images | The step on the state line | — | — |

### 8. Keyboard, screen readers and narrow screens

- Every row, link and button has a visible focus ring, as the Boxes page
  does. ([focus](067-settings-page/new/30-focus-ring.png))
- Every switch has a name of its own: "Linux desktop (GPU): offered to
  threads", "Proxmox LXC on pve-1: takes new boxes", with its row's state
  as its description. Kinds are named in full everywhere, never by a chip
  alone.
- Help and errors are tied to their field with `aria-describedby`; a
  field with a problem is marked invalid. On a refused save the first
  invalid field is scrolled into view and focused; the bar's Show does the
  same.
- Saving, conflicts and Find's result count are announced through polite
  live regions. A secret's buttons say what they do: "Replace the API
  token secret".
- Keyboard navigation and reduced motion move nothing: pages change in
  place. Pointer navigation slides a page 12 px over 220 ms.
- Below 640 px each setting stacks its label over its control, inputs take
  the full width, the size grid becomes blocks, the header's controls wrap
  under the title, and the save bar wraps its buttons under its words.
  ([narrow backend](067-settings-page/new/26-narrow-backend.png))

### 9. Find a setting

Find is in the top row of every view. Its index is built from the drivers'
field descriptors and the option pages, not kept by hand: every field of
every backend, each Mac's own fields, each kind's sizes, largest size,
spares and warm count on each backend, and every option. Each word of the
query must match the setting's label, place, help or key, or a synonym
added beside it (memory and RAM, cores and CPU); words are not replaced.
Results show each setting's value. Arrow keys move, Enter opens, Escape
clears, and the count is announced. Opening a result scrolls to the
setting, opens its folded card or its Mac, focuses it, and highlights it
for a moment; the query stays in the field when the person comes back. Find
does not take the browser's own Find shortcut.
([Find](067-settings-page/new/28-find.png),
[opened a Mac's field](067-settings-page/new/29-found-mac-field.png))

### 10. Words

Headings, labels and help are plain English and short, in sentence case.

| Today | Becomes | Why |
| --- | --- | --- |
| Configuration, over everything | BB's own "Configuration" heading only | BB draws it |
| Set up, on every backend | The row opens the backend's page; "Set up" only for a new backend | A working backend is not being set up |
| Needs setting up | Not finished | It was saved part way, on purpose |
| Ready · checked 6 hours ago | Last check passed · 6 hours ago | It may have changed since |
| Needs attention, for a failure | Not working (fail), Needs attention (warning) | Two different things |
| Linux, for the Android emulator; macOS, for the iOS Simulator | The kind's name, in full: Android emulator, Linux desktop (GPU) | The OS is not the kind |
| From Proxmox LXC and SSH host pool and Docker and … | "6 backends", named on the kind's page | Scannable |
| Backends that can make it, first with room first | A new box goes to the first backend in this list with room | Says the order |
| iOS video auto · encoder shared | iOS video: automatic | Plain |
| No backend you have can make it. Add one of: proxmox-qemu | No backend you have makes it. Proxmox QEMU does. Add a backend | Labels, not IDs, and a way on |
| A save made from an older revision is refused, so two people never overwrite each other unseen | Each save names the revision it was made from. When someone saved first, the page checks your changes against theirs | Says what happens now |
| Enrol boxes as BB machines | Boxes join BB as machines | Plain |
| Refresh interval | Refresh every … s | The unit is beside the number |
| All 1 backend ready | Docker on this machine is ready | Names it |

The drivers' help text is part of the build (unit 4): each field's first
sentence must stand alone, and stale words go, such as Tart's "ios boxes
are not offered yet" on a page that offers them. The owner approves the
new words with that unit.

### 11. Look and motion

The page uses BB's tokens and bb-box's own parts, as the Boxes page and the
Monitor do: hairline cards, BB's status dot and chips, one state line per
row, BB's button, switch, input, select, menu and alert dialog from
`components/ui`, and `StatusDot`, `Meta` and `Badge` from
`src/app/common.tsx`. Motion is quiet: a page slides 12 px with a strong
ease-out over 220 ms; the save bar rises 8 px over 200 ms; "Saved" fades
after 1.6 s; a found setting's ring fades over 1.4 s. Typing, switching
and keyboard actions do not animate.

### 12. How it is built

Kept from today's code: `useLive("config")` and the change signal;
`config.get`, `config.check` with `test`, `config.apply` with the
revision; the helpers in `src/app/config.ts`; `FieldControl`'s parts;
`TailnetSection`, `BoxFilesSection`, `RebuildNow` with its run states,
`FirstRun` and `SetupProgress` with their guidance; the Docker hosts'
`hostState`, `buildWords` and `dockerFacts`; `sparesWords` and
`warmShortWords`; and `Report`, restyled.

New in the app: `SettingsView` (hash routes, the top row, focus and scroll
restore), `Overview`, `BackendPage`, `KindPage`, the option pages,
`AddBackend`, `SetupBackend`, `FindSettings` with its index; and the
editing engine: `useDraft` (paths, merge, conflicts, secret versions,
checked retries, lost-reply reconcile, submitted versions, draft storage),
`useInstant`, `SaveBar`, `ConflictNote` and `RestoredNote`.

Changes on the server, all small:

- Each secret in `config.get` carries an opaque change version, the
  revision that last set it (`{ set, version }`); `config.apply` sets it
  for each secret it replaces or clears. No value ever leaves bb-box.
- A backend's state carries the revision its configuration last changed
  at, and each doctor report the revision it tested, so "not checked since
  it changed" is exact.
- A field group `ios-hosts` for the shared iOS host fields of Tart, the
  SSH host pool and Namespace.
- `draftFields` keeps an explicit empty value for fields where empty means
  off, instead of dropping it and so restoring a default.
- An RPC `config.migrated.remove`, as `bb box config migrated --remove`.
- For live checks only, a test switch that makes `config.apply` drop its
  reply after storing, so a lost reply can be shown on a real BB.

Build units, each one PR with its tests, a keyboard-only pass, screenshots
at 1440, 760 and 390 px beside the Boxes page, and a live check on a
separate BB in a box: a fresh `npx bb-app` with no account, bb-box
installed from the unit's branch. Until a unit lands, today's form for
that part stays reachable from its new page, so no release loses a way to
edit anything.

| Unit | Change | Live check |
| --- | --- | --- |
| 0 | The hash test | Done, above |
| 1 | `SettingsView`, the overview's rows, switches and honest Status, Options rows with the Monitor switch, Machines as a link to the Boxes page's Machines tab, the hash and focus rules; each part's page opens today's form for it, unchanged | Deep links, back, forward, reload, leaving by BB's sidebar; switches refused and saved; keyboard to every row |
| 2 | The editing engine on the two simplest pages, Boxes and Monitor: drafts, merge, conflicts, checked retries, lost replies, submitted versions, draft storage; the server's secret versions and the test switch | An agent's `bb box config apply` while a draft is open; two tabs saving the same field and different fields; a lost reply after a store; typing during a save; a reload with a draft |
| 3 | The backend's page on the engine: health card with check revisions, facts, field cards, help one step in, effective values, explicit off, Macs with their own sizes, the menu and confirmed removal; `ios-hosts` group | A Docker backend edited, refused and saved; a secret replaced in two tabs; a Tart backend with a real Mac's own sizes on a Mac box; remove refused with boxes and confirmed without |
| 4 | The drivers' help text, trimmed for the owner's approval | The pages read in full |
| 5 | Docker on BB machines folded into Backends and Add backend, with "Cannot host boxes" | A second BB machine in a box with Docker, used, broken (no docker group), fixed, turned off |
| 6 | The kind's page, the default-kind rule everywhere, kinds staying in place | A kind edit racing a warm-count edit in another tab; the default kind's switch on both surfaces |
| 7 | First run, Add backend and setting up a backend | A fresh BB with Docker missing, without access, with too little disk, and ready; a backend saved off, resumed and turned on |
| 8 | Images, with every run state and projects' images | A run with a waiting and a failing image; a project's image removed |
| 9 | Devices and Network | The tailnet's choice and credentials saved together and refused part way |
| 10 | Configuration: export, import with its change list, `config.migrated.remove` | Export, change, import against a moved revision |
| 11 | Find | Searches across every field, a Mac's own field, a kind's size, several words, no match; keyboard only |

`docs/design/settings.md` is rewritten to this design in unit 1, and the
reference and the skill name any new words.

## Every setting, and where it goes

Nothing is lost. The left column is how the configuration names it.

| Setting | Today | New place |
| --- | --- | --- |
| BB Box on or off | BB's header | BB's header, unchanged |
| First run (`setup.offer`: Use Docker on this machine, missing Docker, no access, too little disk, failed build, machine access, a remote machine with Docker) | Top of the page | Overview, "Set up BB Box", until a backend that is on makes a kind, with every one of today's states (section 6) |
| Image build progress after first run | Top of the page | Overview's first-run card, and the Docker backend's state line |
| Your machines (036): list, add, start, stop, resize, remove, open desktop and terminal, copy address, threads on each | Machines section | The Boxes page's Machines tab, which already has them all through the shared `MachineRow`; the Options row opens that tab, empty or not |
| `backends[].enabled` | Backend row switch | Backend row switch, and the backend page's header |
| `backends[].label` | Not on the page | Backend page, menu, Rename… |
| `backends[].id` and adding another of a type | Not on the page, but for one row per type | Add backend; a type that allows several, such as Docker and microsandbox, can be added again |
| Removing a backend | Not on the page | Backend page, menu, Remove backend, when it has no boxes |
| `backends[].fields` | Set up area | Backend page, by card; every field is listed below |
| `backends[].hosts` (Tart's Macs: name, on or off, fields) | Set up area, Hosts | Backend page, Macs |
| `backends[].warm` (warm boxes per kind), and shortfalls for want of room | Kind editor, Warm boxes, with "Has 0 of 1 ready: no room" | Kind page, Where it runs, with the shortfall and its reason; the backend page's In use card; Status |
| Docker on BB machines (`docker.host.set`), with its image build, offline and failing states | Its own section, every BB machine | Backend rows for machines in use, with the build and offline state on the state line; Add backend for machines with Docker, and "Cannot host boxes" with the reason for Docker that fails; one line for machines with no Docker; `docker.host.set` still does the work, images included |
| Doctor: Check, last report, notes | Set up area | Backend page's health card, bound to the revision it tested; Check all and the callout on the overview |
| Setup guide and scripts | Set up area, top | Setting up a backend, step 1; the foot of the backend page; its menu |
| `kinds.<id>.enabled` | Kind row switch | Kind row switch, and the kind page's header |
| `kinds.<id>.presets` (cores, memory, disk) | Kind editor | Kind page, Sizes |
| `kinds.<id>.default` | Kind editor | Kind page, Sizes, Default column |
| `kinds.<id>.largest` | Kind editor | Kind page, Sizes, Largest |
| `kinds.<id>.spares`, device spares included, and spares ready or being made | Kind editor and its status line | Kind page, Spare boxes, with how many are ready or being made; linked from Devices for iOS and Android |
| `general.defaultKind` | General | Boxes; and Make default on a kind's page |
| `general.boxesPerThread` | General | Boxes |
| `general.enrol` | General | Boxes, "Boxes join BB as machines" |
| `general.video` | General | Boxes |
| `general.nightlyImages` | General | Images, "Rebuild each night" |
| Rebuild now (`images.list`, `images.refresh`, `images.progress`), with run states rebuilt, waiting, failed, skipped and not started | General, beside the switch | Images: each standard image with what the last run did, Rebuild what is due with each image's progress, and a failed rebuild in Status |
| `general.files` | Files for every box | Boxes, Files for every box |
| `general.tailnet` (mode, tags, OAuth client ID and secret) | Tailnet | Network |
| `general.testDevice` | Not on the page | Devices, For testing |
| `general.encoderLedger` | Not on the page | Devices, "Share each Mac's encoder fairly" |
| `general.iosEncoder` | Not on the page | Devices, "iOS video encoding" |
| `monitor.enabled` | Monitor | Monitor, "Machine status" |
| `monitor.refreshIntervalSeconds` | Monitor | Monitor, "Refresh every" |
| `monitor.backgroundMonitoring` | Monitor | Monitor |
| `monitor.pressureNotifications` | Monitor | Monitor |
| `images.<name>` (projects' images: kinds, projects, script, check, bake, source, updated) | Not on the page; `bb box image` | Images, Projects' images: script and check shown, when built ahead changed at once, Remove… with what follows. Set stays with `bb box image set`, as agents set them from a project's files |
| Revision, and a change made elsewhere | A banner | Field-level merge with conflicts on their rows (section 4); Configuration says how it works |
| Export and import (`bb box config show --json`, `config apply`) | Not on the page | Configuration |
| The copy of BB's earlier settings (`config.migrated`) | Not on the page | Configuration, Remove copy |
| Per-Mac and per-backend host sizes: Tart's per-Mac shared iOS host cores, memory and slots; each backend's memory and disk kept free; Hetzner's server types; Namespace's largest machine | Set up area | Each backend's page: under each Mac; Shared iOS hosts; Advanced; Boxes |
| iOS shared hosts (`ios-hosts-*` on Tart, the SSH host pool and Namespace) | Set up area, Boxes and Advanced | Each of those backend's pages, Shared iOS hosts; linked from Devices |

Clipboard: there is no clipboard setting in the configuration. Copy and
paste are per viewer, in each desktop's and device's own menu, and stay
there. Nor are a viewer's own choices settings (video or VNC, which display,
the device frame, the New box form's last choices, the Monitor panel's
shape): each browser keeps them, and they stay where they are.

Every backend field, by backend. Fields named `ios-hosts-*` move from Boxes
or Advanced into the new Shared iOS hosts card; every other field keeps its
group.

| Backend | Today, in its Set up area | On its own page, by card |
| --- | --- | --- |
| Proxmox LXC | 22 fields: Connection 4, Credentials 3, Boxes 5, Advanced (folded) 10 | Connection: API URL; Node; TLS fingerprint; CA certificate<br>Credentials: API token ID; API token secret; SSH private key<br>Boxes: Resource pool; Linux templates; GPU desktop templates; CPU desktop templates; CPU Wayland desktop templates<br>Advanced (folded): Desktops per GPU; Network bridge; Subnet; Gateway; Box addresses; First box VMID; Last box VMID; SSH user; Memory kept free (MiB); Disk kept free (GiB) |
| Proxmox QEMU | 23 fields: Connection 4, Credentials 3, Boxes 7, Advanced (folded) 9 | Connection: API URL; Node; TLS fingerprint; CA certificate<br>Credentials: API token ID; API token secret; SSH private key<br>Boxes: Resource pool; Windows templates; Linux templates; Linux desktop templates; Android templates; Windows boxes as BB machines; KVM in Linux VM boxes<br>Advanced (folded): Network bridge; Subnet; Gateway; Box addresses; First box VMID; Last box VMID; SSH user; Memory kept free (MiB); Disk kept free (GiB) |
| SSH host pool | 7 fields: Connection 1, Credentials 1, Boxes 1, Advanced (folded) 4 | Connection: Host keys<br>Credentials: SSH private key<br>Boxes: Machines<br>Shared iOS hosts: Slots for ios boxes per Mac; Ready slots for ios boxes kept on a Mac; Slots a Mac sweeps at once; Disk a Mac keeps free of slots (GiB) |
| Tart | 22 fields: Credentials 1, Boxes 9, Advanced (folded) 12, Hosts (6 fields each) | Credentials: SSH private key<br>Boxes: macOS image; macOS desktop image; Linux image (arm64); Linux desktop image (arm64); Windows image (arm64); iOS image; Windows boxes as BB machines; Video by default for macOS desktops<br>Shared iOS hosts: Shared iOS hosts; Slots per shared iOS host; Ready slots kept on a shared iOS host; Slots a shared iOS host sweeps at once; Cores of a shared iOS host; Memory of a shared iOS host (GiB); Shared iOS hosts per Mac; Disk a shared iOS host keeps free (GiB)<br>Advanced (folded): VM user; VMs per Mac; Memory kept free (MiB); Disk kept free (GiB); Hours a macOS warm VM or spare is kept<br>Macs: name; on or off; Address; User; Host keys; and under each Mac its own Slots per shared iOS host; Cores of a shared iOS host; Memory of a shared iOS host (GiB) |
| Docker | 10 fields: Connection 1, Boxes 5, Advanced (folded) 4 | Connection: Host<br>Boxes: Linux image; Desktop image; Wayland desktop image; Docker in boxes; GPU desktops<br>Advanced (folded): Desktops per GPU; Network; Most boxes; Memory kept free (MiB) |
| microsandbox | 12 fields: Connection 1, Boxes 5, Advanced (folded) 6 | Connection: Host<br>Boxes: Linux image; Desktop image; Linux image (arm64); Desktop image (arm64); Docker in boxes<br>Advanced (folded): Docker disk (GiB); Root disk (GiB); Network profiles; Most boxes; Memory kept free (MiB); Memory overcommit |
| Hetzner Cloud | 16 fields: Connection 1, Credentials 1, Boxes 9, Advanced (folded) 5 | Connection: Location<br>Credentials: API token<br>Boxes: Server type; Arm server type; Most hosts; Idle minutes; Monthly limit (EUR); Linux image; Desktop image; Wayland desktop image; Docker in boxes<br>Advanced (folded): Host image; SSH from; Most boxes; Memory kept free (MiB); Network |
| Namespace | 11 fields: Connection 2, Boxes 5, Advanced (folded) 4 | Connection: API token; API region<br>Boxes: macOS version; Most machines; Longest life (hours); Largest machine<br>Shared iOS hosts: Shared iOS hosts; Slots a host lends at most; Slots a host keeps ready; Slots a host resets at once; Disk a host keeps free (GiB) |

## Open questions for the owner

Both reviews agreed with each default. The prototype shows them, and the
build follows them unless the owner says otherwise.

1. Machines leave the settings page for the Boxes page's Machines tab, with
   a row in Options that opens that tab, empty or not. Default: yes.
2. Backends that are not set up are no longer rows; they are found under
   Add backend. Backends that are off or not finished stay rows. Default:
   yes.
3. Kinds that are off fold into one row, and so do kinds no backend you
   have makes. A kind switched off on this visit stays in place until the
   person leaves. Default: yes.
4. The default kind's switch is disabled on every surface, with the reason
   and a link to choose another default. Default: yes.

## Alternatives considered

- Settings in the Boxes page, which owns a route. Not needed: unit 0
  showed the hash works on BB's settings page, and settings stay where BB
  keeps every plugin's.
- A leave dialog that asks before any navigation. A plugin cannot stop
  BB's sidebar or search, so it would only sometimes ask. Drafts that
  survive leaving, with the browser's warning on close or reload, cover
  every path.
- Saving every change at once, or every change with Save. Each breaks
  something: settings that belong together would be applied half done, or
  a quick switch would need a second step. The rule in section 4 keeps
  each where it belongs and makes the difference visible.
- Tabs across the top, one page with a table of contents, and a drawer for
  a backend's form: rejected in the first round, for hiding Status,
  shortening nothing, and not being linkable.

## The prototype

Open [067-settings-page/prototype.html](067-settings-page/prototype.html)
in a browser. It is one file with nothing to install, and it saves nothing
outside the browser tab. A fake server answers in about 0.7 s, with the
owner's backends and kinds under generic names, and behaves as bb-box does:
revisions, secret versions, a write before the reply, refusals by field.
Add `?light` to the address for the light theme. The view is in the URL's
hash, so back, forward, reload and links to a view work as in BB.

BB's sidebar works: choose General to leave and BB Box to come back, or use
the browser's back button. Unsaved changes stay.

The dashed Prototype panel, bottom left (top right on a phone), sets:

- the scenario: All ready, Problems (Tart's Mac does not answer, a Docker
  machine is offline, a warm pool is short, a kind is not offered, an image
  failed to rebuild), or First run;
- what the next save does: works, is refused, or saves but loses its reply;
- An agent runs bb box config apply: changes the configuration while the
  page is open, as an agent would;
- Bring mac-1 back, in Problems, so Check again recovers;
- Docker on BB's server, in First run: ready, missing, no access, or low
  disk;
- dark or light, and Reload the page.

Worth trying:

1. On Proxmox LXC's page, change Node and Memory kept free, then press the
   agent button: the memory field shows its conflict, Node keeps your
   value. Choose Use theirs, then Save.
2. Replace the API token secret, press the agent button: the secret's
   conflict names the revision.
3. Set the next save to lose its reply, change a field, Save: "Save not
   confirmed", then "Saved. The reply was lost…".
4. On Monitor, type 10, Save, and at once type 15.
5. Change a field, choose General in BB's sidebar, come back: the row says
   "Unsaved changes". Reload: the change comes back, and the pasted secret
   is asked for again.
6. First run: Choose another backend, Proxmox LXC, Save and turn on with
   nothing filled in, then Save, keep it off, then back.
7. Find: "iOS memory", "CPU desktop", "turn off monitor", "mac-1 cores".
8. Tab through the overview, Enter on a row, then back.

To rebuild it, on a box: `npm ci` at the repository's root, then `npm ci`
and `npm run build` in `docs/decisions/067-settings-page/prototype`, which
writes `prototype.html` beside the folder. The prototype's own packages are
its build tools; React and the components come from the root.
`npx tsc -p tsconfig.json --noEmit` there typechecks it.

## What changed after the reviews

Two independent reviews (Opus and Astra, 29 October 2026) asked for changes
before building, not a rethink. Each finding, what changed, and where to
see it.

| Finding | Change | In the prototype |
| --- | --- | --- |
| Both: edits do not follow changes made elsewhere; Use the saved value drops other edits; a "part" is not a subtree | Field-level merge from where each edit began; untouched fields follow the stored value; conflicts on their rows at once; each choice acts on its field only; a part is the paths a form writes (section 4) | Proxmox LXC, try 1 |
| Astra: secrets cannot be compared; retries must use a checked revision | Opaque secret change versions from the server; a stale secret is a conflict; every retry re-checks the latest revision first (sections 4, 12) | Try 2; Configuration page |
| Astra: "Nothing was saved" is not known; "Saved" beside newer typing | "Save not confirmed", then reconcile with what is stored; "Saved" covers what was sent (section 4) | Tries 3 and 4 |
| Both: one saving rule that holds; dependent fields; Enter; Discard; removals | Switches act at once; forms use checkboxes and radio choices and one Save; Enter saves; Discard's effect stated; every removal confirms its consequences (section 4) | Network page; Tart's Macs; Remove backend… |
| Both: drafts lost on BB's navigation, setup, files | Drafts kept outside the page, non-secret parts in session storage, secrets in memory only, restored with a note; browser warning on close; files keep their text on refusal (section 5) | Try 5; Boxes, Add file with the next save refused |
| Both: default kind off from the overview; rows vanishing | Default kind's switch disabled everywhere with a reason and a link; a default kind found off is a problem; a kind turned off stays in place this visit (sections 2, 3) | Overview, Kinds |
| Both: hash unproven; BB's header missing on inner pages; back to an empty setup form | Unit 0 run in a real BB: the hash works; BB's chrome shown on every view; a top row with where you are, Back to the previous view, and Find; setup replaced by the backend's page in history; focus and scroll restored (section 1) | Any inner page; try 6 and 8 |
| Both: Status overstates freshness and covers too little | Honest states: ready, last check passed and its age, not checked since it changed, checking, off, not finished; ranges of ages; Check all as main button when stale; the callout covers kinds, warm shortfalls, image failures, failing Docker machines, unfinished backends and the default kind (sections 2, 7) | Overview in All ready and Problems |
| Both: first run noisy, ends too early, loses today's guidance; "Check the connection" ran everything | First run until a backend makes a kind; today's missing, no-access, low-disk, failed-build and remote-machine guidance; resume an unfinished backend; quiet folded kinds; "Docker on this machine is ready"; setup's check is its own step, named for what it does (sections 3, 6) | First run, with the Docker choices |
| Both: backend pages are walls of text | First sentence of help, More for the rest; Shared iOS hosts and Advanced folded with a summary; driver help trimmed in unit 4 (sections 3, 10) | Proxmox LXC, Tart |
| Astra: effective values; blank means four things; the new-boxes note disappears | Placeholders give the value and its source; Offer checkboxes for empty-means-off; `draftFields` keeps an explicit empty; the note stays (sections 3, 12) | Proxmox LXC's Boxes card; Tart's Mac |
| Both: no focus ring on rows; focus lost; duplicate names; errors not tied or off screen; motion on keyboard | Focus rings on every row; heading focused on open, row on back; full names on switches; help and errors described by; first error scrolled into view and focused; no motion for keyboard or reduced motion (section 8) | Try 8; a narrow kind with a bad size |
| Astra: narrow layout | Rows stack below 640 px; sizes become labelled blocks; header and bar wrap (section 8) | Any page at 390 px wide |
| Both: Find misses fields, takes one word, loses the query, shows no values, overview only | Index from descriptors with every field, Mac field, size and warm count; each word matched, synonyms added; values shown; keyboard and live count; query kept; in every view; browser Find left alone (section 9) | Try 7 |
| Opus: Status above Find | Find sits in the same top row on every view, one line high; Status is the first thing below it on the overview, so the answer to task 1 stays in the first screen (sections 1, 2) | Overview |
| Opus: Monitor off is slower | The switch on the Monitor row; Reload BB now after it changes; the panel links to the page (sections 2, 3) | Overview, Options |
| Opus: small losses | Warm shortfalls, "Cannot host boxes", spares being made, rebuild run states, `docker.host.set` with its build, Copy saved settings (not the draft) | Problems; Add backend; Images |
| Astra: placeholders | Rename, Import with its change list and Remove copy are working flows, and Your machines opens the Boxes page's Machines tab (a stand-in page in the prototype); export says which secrets to paste again; a project image shows its check script; the fake server checks a Mac's sizes as bb-box does | Backend menu; Configuration; Images |
| Both: build units too broad; unsafe middle releases; missing checks | Unit 0 done; eleven smaller units; today's forms stay reachable until replaced; the engine first on simple pages; checks for lost replies, two-tab secrets, racing warm counts, refused files, first-run failures, real per-Mac sizes, keyboard and screenshots at three widths (section 12) | — |
| Both: words | The words table in section 10 | Throughout |
