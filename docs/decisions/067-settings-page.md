# 067: The settings page is an overview, with a page one step in for each backend, kind and option

Status: proposed, 29 October 2026, for the owner's review. Nothing is built.

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
(Plugin SDK 0.6.15). Anything deeper than one page is the plugin's own
state. A `navPanel`, such as the Boxes page, owns a route and its
sub-paths.

## Decision

### 1. The page stays in BB's Settings, as an overview with pages one step in

The page stays where BB puts plugin settings, so it belongs in BB. It
becomes an overview with one page one step in for each backend, each kind
and each group of options. A page replaces the overview in place, with
"BB Box settings" as its back link at the top, as BB's own "Plugin details"
link does. The page's state is kept in the URL's hash, such as
`#backend/proxmox-lxc`, so a link from the Box panel or the Boxes page can
open it and the browser's back button works. The build checks that BB keeps
the hash (unit 1); if it does not, the page keeps its state in memory and a
BB request asks for a sub-path for settings sections.

Every setting is at most one step from the overview. Nothing is on the page
twice.

### 2. The overview, in order

| Part | What it shows at a glance | One step in |
| --- | --- | --- |
| Find a setting | A field. Typing replaces the overview with matching settings, each with where it lives | The setting's page, scrolled to it and highlighted for a moment |
| Status | One line: "All 8 backends ready · 1 off · 10 kinds on offer · checked 6 hours ago", and Check all. With a problem, a callout lists each backend in trouble with its fix in words and an Open button | The backend's page |
| Backends | One row each: icon, name, the host it is on as a chip, one state line, the on switch | The backend's page |
| Kinds | One line each, grouped as Linux; macOS and iOS; Windows and Android: name, chips, default size, how many backends make it, warm and spare counts, the on switch. Kinds that are off fold into "2 kinds off". On a narrow window the summary moves under the name | The kind's page |
| Options | One row each, with its present value: Boxes, Images, Devices, Network, Monitor, Configuration, and a link to Your machines on the Boxes page | The option's page |

At the owner's configuration the overview is about 1,950 px tall, against
4,242 px today, and the answer to task 1 is in its first line.
([overview](067-settings-page/new/01-overview.png),
[with a problem](067-settings-page/new/10-problem-overview.png))

Machines leave the settings page: the Boxes page's Machines tab already
does all they did. Docker on BB machines joins Backends: a machine in use is
a Docker backend row with a "BB machine" chip, and machines that could host
boxes are offered under Add backend, and in one line under the list. Those
with no Docker are one line there, not a row each.

### 3. Each page

A backend's page ([page](067-settings-page/new/03-backend.png)):

- The header: icon, name, the host chip, the description, the on switch, and
  a menu with Copy as JSON, Rename…, Open the setup guide and Remove
  backend. Remove is disabled, with its reason, while the backend has
  boxes.
- Health: one card. Its first line is the state and the summary. Its second
  is "11 of 11 checks passed · checked 6 hours ago" and Check again. Failed
  checks and warnings come first, each with its name, its detail on its own
  line, and "Fix:" with the fix in words. Passed checks fold into "Show the
  11 checks". Notes, such as a public key to install, show in a code block
  with Copy. With unsaved changes, Check runs against them, and the card
  says "Checked just now, against your changes. Nothing is saved yet."
- In use: boxes now, the kinds it makes (each a link to the kind), and the
  boxes kept warm on it.
- The driver's fields, in cards by group: Connection, Credentials, Boxes,
  Shared iOS hosts (for Tart, the SSH host pool and Namespace) and
  Advanced, folded, saying how many settings it holds. Each field is a row:
  label and help text on the left, its control on the right; long text
  takes the full width. A field the backend takes from another, as Proxmox
  QEMU takes Proxmox LXC's connection, shows that value as its placeholder
  and a "from Proxmox LXC" chip.
- Tart's Macs: one row each with its address and switch; a row opens to
  edit its fields and its own shared iOS host size.
- At the foot, the setup guide and its scripts as links.

A kind's page ([page](067-settings-page/new/21-kind.png)):

- The header: the kind's name and chips, its description, Make default, and
  the on switch. The default kind's switch is disabled, with the reason
  under it.
- Sizes: a grid of Small, Medium and Large by cores, memory and disk, the
  default chosen in its own column, and the largest custom size below.
- Where it runs: each backend that can make it, with how its boxes are made
  (LXC, VM, container, microVM or physical machine), whether it makes it
  now, and its warm count.
- Spare boxes: the count, and how many are ready. On the iOS Simulator and
  Android emulator kinds it says that spares are off by default, as each
  keeps a booted device and its memory saved to disk.

Options' pages:

| Page | Holds |
| --- | --- |
| Boxes | Default kind, boxes per thread, boxes join BB as machines, Linux desktops as video; Files for every box |
| Images | Rebuild each night; the standard images with their age and why each is due, and Rebuild what is due with its progress; projects' images, each with its kinds, projects, source and script, when it is built ahead, and Remove ([page](067-settings-page/new/23-images.png)) |
| Devices | iOS video encoding; share each Mac's encoder fairly; links to the shared iOS hosts on each backend and the spares of each device kind; the test device ([page](067-settings-page/new/24-devices.png)) |
| Network | The tailnet: whether machines join, tags, OAuth client ID and secret |
| Monitor | Machine status, refresh every, background monitoring, pressure notifications |
| Configuration | The revision; Export (Copy as JSON, no secret in it); Import (checked first, with what it changes listed before anything is saved); the copy of BB's earlier settings and Remove copy; the `bb box config` commands |

Add backend ([page](067-settings-page/new/16-add-backend.png)) lists
Docker on your BB machines first, as it is ready now, then every backend
grouped by where boxes run: on this server or a machine you have; on a
Proxmox VE host; on your Macs with Apple silicon; in the cloud, paid by use.
Each tile says what it makes and what it needs. A backend that cannot be
added twice says "Added" and opens its page.

Setting up a backend ([page](067-settings-page/new/17-setup.png)) is
the backend's page in three numbered steps: 1, Prepare: the setup guide and
its scripts in the order it runs them; 2, Connect: connection and
credentials, and Check the connection, which runs the backend's checks
against the form; 3, Choose what it makes: the Boxes fields, with "It will
make: Linux, Linux desktop" kept up to date as templates are filled in,
and Advanced folded. Its bar offers Save and turn on, Save, keep off, and
Cancel.

First run ([page](067-settings-page/new/14-first-run.png)): with no
backend, the overview starts with "Set up BB Box": one offer, "Use Docker
on this machine", where BB's server has Docker (the Box panel's first-run
offer, from `setup.offer`), and "Choose another backend". While the image
builds, the card shows its progress, as the Box panel does. Kinds and
Options stay below, so sizes can be set before a backend exists.

### 4. One rule for saving

What you click saves at once; what you type waits for Save.

- Switches, menus and radio buttons save at once. The control shows it is
  saving, then "Saved" beside it for a moment. A refusal puts the control
  back and says why under its row, with the fix:
  "Not turned on: paste the API token secret."
- Typed fields wait. The first change brings up a bar at the foot of the
  page: "2 changes not saved", with Discard and Save, and Check on a
  backend's page. Enter in a field saves. Leaving the page with changes
  asks "Discard your changes to Proxmox LXC?"
  ([unsaved](067-settings-page/new/05-backend-problems.png))
- The bar tells the outcome: "Saving…", then "Saved" for 2 s
  ([saved](067-settings-page/new/08-backend-saved.png)); "Not saved: fix
  the field marked", with the field's row tinted, its reason under it, and
  the page scrolled to it; or, when BB Box did not answer, "BB Box did not
  answer within 10 s. Nothing was saved; your changes are still here", with
  Try again ([failed](067-settings-page/new/06-backend-save-failed.png)).
- A configuration changed elsewhere: the page saves against the revision it
  read, as today. When it is refused, the page reloads the configuration.
  If the part being saved (this backend, this kind, this option) did not
  change, it saves the change again on the new revision by itself and says
  "Saved, after another change made elsewhere". If it did change, the bar
  names each field changed both ways, with the saved value and yours, and
  offers Use the saved value or Save mine
  ([conflict](067-settings-page/new/09-conflict.png)).

### 5. Each part's states

| State | Overview | A backend's page | A kind's page | Options |
| --- | --- | --- | --- | --- |
| First run, no backend | "Set up BB Box" card in place of Status and Backends | Not reached | Sizes can be set; Where it runs says no backend can make it yet | As usual |
| Loading | Rows keep their place, in skeleton | The same | The same | The same |
| Checking | Status: "Checking 8 backends…"; each row "Checking…" with BB's spinner | Health card "Checking…, up to 30 s" | — | — |
| Healthy | One green line | "Ready" and the passed count | Green dot per backend | — |
| A problem | Callout listing each backend in trouble, its fix in words, and Open; the row says "Not working" in red or "Needs attention" in amber | Failed checks first, each with Fix | "Cannot make it now" in amber; a kind no backend can make says "Not offered: no backend can make it now" | — |
| Not finished, saved off with problems | "Not finished" and the first problem | The fields marked | — | — |
| Off | "Off · takes no new boxes" | "Off: it takes no new boxes. Check it before you turn it on." | "Off" | — |
| Saving, saved, failed, changed elsewhere | The switch's own states | The bar | The bar | The bar, or the control's own states |

### 6. Words

Headings, labels and help text are plain English and short, in sentence
case, and name what a thing does. The words that change:

| Today | Becomes | Why |
| --- | --- | --- |
| Configuration (a heading over everything) | No heading | The whole page is configuration |
| Set up, on every backend | The row opens the backend's page; "Set up" only for a new backend | A working backend is not being set up |
| Needs setting up | Not finished | It was saved part way, on purpose |
| Needs attention, for a failed check | Not working (fail), Needs attention (warning) | Two different things |
| Linux, for the Android emulator kind; macOS, for the iOS Simulator kind | The kind's own name | The OS is not the kind |
| From Proxmox LXC and SSH host pool and Docker and … | "6 backends", named on the kind's page | Scannable |
| Enrol boxes as BB machines | Boxes join BB as machines | Plain English |
| Refresh interval | Refresh every … s | The unit is beside the number |
| Rebuild images each night (under General) | Rebuild each night (under Images) | It lives with what it rebuilds |
| Edit, Set up, Check | Open by the row; Check again; Check the connection | Each says what happens |

The prototype's words are the proposed words. Driver help text stays as
the drivers give it; trimming it is a later change, in the drivers.

### 7. Look and motion

The page uses BB's tokens and bb-box's own parts, so it matches the Boxes
page and the Monitor: cards with hairline rows, BB's status dot and chips,
one state line per row, icon buttons with tooltips, and BB's button, switch,
input, select, menu and alert dialog from `components/ui`. Section headings
are BB's small titles with one line of help.

Motion is quiet and quick: a page slides 12 px in from the side it is
reached from, over 220 ms with a strong ease-out, and back the other way;
the save bar rises 8 px over 200 ms; "Saved" fades after 1.6 s; a found
setting's ring fades over 1.4 s. Typing in Find, switching, and keyboard
actions do not animate. With reduced motion, pages and the bar fade in
place and nothing moves.

### 8. How it is built

Kept from today's code:

- The data: one `useLive("config")` at the page's root, `config.get`,
  `config.check` with `test`, `config.apply` with the revision, and the
  helpers in `src/app/config.ts` (`withBackend`, `withKind`, `withGeneral`,
  `withMonitor`, `effectiveKind`, `inheritSource`, `draftFields`,
  `groupFields`, `problemAt`, `problemsLeft`).
- The controls: `FieldControl` and its write-only secret control, the kind
  form's size parsing, `TailnetSection`, `BoxFilesSection`, `RebuildNow`,
  `FirstRun` and `SetupProgress`, the Docker hosts' `hostState`,
  `buildWords` and `dockerFacts`, and `Report`, restyled.
- The RPC as it is. Check all uses the existing `doctor` call; the build
  makes sure its results become each backend's last check, as a backend's
  own Check does. The server changes only by the two small additions below.

New:

- `SettingsRoot`, the page's view stack with its hash, back link and leave
  guard; `Overview`; `BackendPage`; `KindPage`; one component per option
  page; `AddBackend`; `SetupBackend`; `FindSettings` and its index.
- `useEditing`, which holds a page's draft, counts changes, saves through
  `config.apply`, and handles problems, a failed call and a changed
  revision; `useInstant`, the same for a control that saves at once; and
  `SaveBar` and `SavedTick`.
- In the drivers: a field group `ios-hosts` for the shared iOS host fields
  of Tart, the SSH host pool and Namespace, so they get their own card.
- An RPC `config.migrated.remove`, so Configuration can remove the kept
  copy of BB's earlier settings, as `bb box config migrated --remove` does.

Build units, each one PR, each with its tests and a live check on a
separate BB in a box: a fresh `npx bb-app` with no account, and bb-box
installed from the unit's branch, as order 11 asks.

| Unit | Change | Live check |
| --- | --- | --- |
| 1 | `SettingsRoot`, the overview with Status, Backends and Kinds rows and their switches, and Options rows; today's General, Monitor, tailnet, files and rebuild sections moved, unchanged, onto the Boxes, Images, Network and Monitor pages; Machines replaced by its link; the hash | With Docker on the box's BB: every row and switch; each option page and back; a link with a hash opens its page; the browser's back button |
| 2 | The backend's page: health card, facts, field cards with `ios-hosts`, Macs, the menu; `useEditing`, `useInstant`, `SaveBar`, the leave guard and the changed-revision handling | Edit and save Docker's fields; a bad value refused and marked; a save while a second tab saved the same backend, and another part; Check against unsaved changes |
| 3 | Docker on BB machines folded into Backends and Add backend's first list | A second BB machine in another box with Docker, used and turned off |
| 4 | The kind's page | Sizes, default, warm and spares saved and refused; the default kind's switch |
| 5 | Add backend, Setting up a backend, the first-run card | A fresh BB with no backend: Use Docker on this machine to a ready Linux box; then microsandbox set up through its steps, saved off, then on |
| 6 | Devices, Images with projects' images, Configuration with export, import and `config.migrated.remove` | Export, change, import, and the change list; a project's image's bake changed and removed |
| 7 | Find a setting | Searches for memory, template, tailnet and a word with no match |

`docs/design/settings.md` is rewritten to this design in unit 1, and the
reference and the skill name any new words.

## Every setting, and where it goes

Nothing is lost. The left column is how the configuration names it.

| Setting | Today | New place |
| --- | --- | --- |
| BB Box on or off | BB's header | BB's header, unchanged |
| First run (`setup.offer`, Use Docker on this machine) | Top of the page | Overview, "Set up BB Box", while no backend exists |
| Image build progress after first run | Top of the page | Overview's first-run card, and the Docker backend's state line |
| Your machines (036): list, add, start, stop, resize, remove, open desktop and terminal | Machines section | The Boxes page's Machines tab, which already has them all; a link row in Options |
| `backends[].enabled` | Backend row switch | Backend row switch, and the backend page's header |
| `backends[].label` | Not on the page | Backend page, menu, Rename… |
| `backends[].id` and adding another of a type | Not on the page, but for one row per type | Add backend; a type that allows several, such as Docker and microsandbox, can be added again |
| Removing a backend | Not on the page | Backend page, menu, Remove backend, when it has no boxes |
| `backends[].fields` | Set up area | Backend page, by card; every field is listed below |
| `backends[].hosts` (Tart's Macs: name, on or off, fields) | Set up area, Hosts | Backend page, Macs |
| `backends[].warm` (warm boxes per kind) | Kind editor, Warm boxes | Kind page, Where it runs; summed on the backend page's In use card |
| Docker on BB machines (`docker.host.set`) | Its own section, every BB machine | Backend rows for machines in use; Add backend for machines with Docker; one line for the rest |
| Doctor: Check, last report, notes | Set up area | Backend page's health card; Check all and the problem callout on the overview |
| Setup guide and scripts | Set up area, top | Setting up a backend, step 1; the foot of the backend page; its menu |
| `kinds.<id>.enabled` | Kind row switch | Kind row switch, and the kind page's header |
| `kinds.<id>.presets` (cores, memory, disk) | Kind editor | Kind page, Sizes |
| `kinds.<id>.default` | Kind editor | Kind page, Sizes, Default column |
| `kinds.<id>.largest` | Kind editor | Kind page, Sizes, Largest |
| `kinds.<id>.spares`, device spares included | Kind editor | Kind page, Spare boxes; linked from Devices for iOS and Android |
| `general.defaultKind` | General | Boxes; and Make default on a kind's page |
| `general.boxesPerThread` | General | Boxes |
| `general.enrol` | General | Boxes, "Boxes join BB as machines" |
| `general.video` | General | Boxes |
| `general.nightlyImages` | General | Images, "Rebuild each night" |
| Rebuild now (`images.list`, `images.refresh`, `images.progress`) | General, beside the switch | Images, standard images and Rebuild what is due |
| `general.files` | Files for every box | Boxes, Files for every box |
| `general.tailnet` (mode, tags, OAuth client ID and secret) | Tailnet | Network |
| `general.testDevice` | Not on the page | Devices, For testing |
| `general.encoderLedger` | Not on the page | Devices, "Share each Mac's encoder fairly" |
| `general.iosEncoder` | Not on the page | Devices, "iOS video encoding" |
| `monitor.enabled` | Monitor | Monitor, "Machine status" |
| `monitor.refreshIntervalSeconds` | Monitor | Monitor, "Refresh every" |
| `monitor.backgroundMonitoring` | Monitor | Monitor |
| `monitor.pressureNotifications` | Monitor | Monitor |
| `images.<name>` (projects' images: kinds, projects, script, check, bake, source, updated) | Not on the page; `bb box image` | Images, Projects' images: shown, bake changed, removed. Set stays with `bb box image set`, as agents set them from a project's files |
| Revision, and a change made elsewhere | A banner | Configuration shows the revision; the save bar handles a change made elsewhere |
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

Each has a default, which the prototype shows and the build follows unless
the owner says otherwise.

1. Machines leave the settings page for the Boxes page's Machines tab,
   with a link row in Options. Default: yes.
2. Backends that are not set up are no longer rows. They are found
   under Add backend. Today every driver has a row, set up or not. Default:
   only backends you have are rows.
3. Kinds that are off fold into one "2 kinds off" row. Default: yes.
4. The default kind's switch is disabled until another kind is the
   default, rather than letting the configuration be saved with a problem.
   Default: disabled, with the reason under it.

## Alternatives considered

- Move settings into the Boxes page as its own tab, which owns a route
  and sub-paths. It would deep-link without the hash, but settings would
  leave the place BB keeps every plugin's settings, and BB's gear for
  BB Box would open a near-empty page. Kept as the fallback if BB does not
  keep the hash and no sub-path comes.
- Tabs across the top of the settings page (Backends, Kinds, Options).
  They hide the one-line status behind a tab and split the overview the
  owner needs every day. Rejected.
- One page with a local table of contents. It shortens nothing: a
  backend's 22 fields still sit in the list. Rejected.
- A drawer or dialog for a backend's form. A form of 22 fields with a
  check report does not fit a dialog, and a drawer cannot be linked to.
  Rejected.

## The prototype

Open [067-settings-page/prototype.html](067-settings-page/prototype.html)
in a browser. It is one file with nothing to install, and it saves nothing:
a fake server answers in about 0.7 s, with the owner's backends and kinds
under generic names. Add `?light` to the address for the light theme.

The dashed "Prototype" panel at the bottom left sets the scenario:

- All ready, A problem (Tart's Mac does not answer, and a Docker machine is
  offline), or First run (no backend).
- The next save fails.
- Before your next save, someone else saves another part, or the same part.
- Dark or light.

Worth clicking: Check all; a backend row, then a field, then Save, Discard
or Check; a kind row, then its sizes; Add backend, then Proxmox LXC, then
Save and turn on with nothing filled in; Find, typing "memory" or
"tailnet"; and in A problem, Open on Tart, then Check again.

To rebuild it, on a box: `npm ci` at the repository's root, then `npm ci`
and `npm run build` in `docs/decisions/067-settings-page/prototype`, which
writes `prototype.html` beside the folder. The prototype's own packages are
its build tools alone; React and the components come from the root. It
uses the repository's own `components/ui`, `lib` and `src/app/common.tsx`,
with a stand-in for the Plugin SDK's icons. `npm run dev` serves it with
reload.
