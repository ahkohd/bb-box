# Design: the settings page

bb-box's page under BB's settings, at `/settings/plugins/bb-box`. It is an
overview, with a page one step in for each backend, each kind and each
group of options. The decision is
[067](../decisions/067-settings-page.md); this note says how the page works
and what is built. The design before it, one long page of ten sections, is
in this file's history.

## Who it is for

One person: the operator of a BB install. Agents do not use the page; they
use `bb box config` and `bb box image`, so the page shows what they set.
The tasks, most frequent first: see whether everything works; turn a
backend, kind or Docker machine on or off; tune a kind; change a backend;
rebuild images; set preferences once; set bb-box up; expert settings.

## Where configuration lives

Configuration is one checked document in the plugin's storage
([decision 029](../decisions/029-configuration-is-one-checked-document.md)),
written only through bb-box's RPC and CLI. Secrets live in it too and never
come back to the browser: the page shows whether each is set.

| Call | Does |
| --- | --- |
| `config.get` | the document, each secret as set or not, each part's problems, a revision, and each backend's live state and last check |
| `config.check(draft, { test? })` | problems keyed by field path, without saving; with `test`, a backend's doctor against the draft, within 30 s. A check of the stored backend is kept as its last check |
| `config.apply(draft, revision, operation?, submission?)` | one checked write; refused when the revision moved on or a field is wrong. With an operation ID, applied at most once: its receipt is listed by `config.get` |
| `docker.host.set(hostId, enabled, operation?)` | Docker on one of your BB machines on or off, with its images, and its receipt with an operation ID |

The page refetches on bb-box's change signal.

## Views and the hash

BB gives a plugin's settings section no route of its own, so the page keeps
its view in the URL's hash (unit 0 of 067 showed BB keeps it):

| Hash | View |
| --- | --- |
| none | the overview |
| `#backend/<id>` | a backend's page |
| `#kind/<id>` | a kind's page |
| `#option/<id>` | Boxes, Images, Devices, Network, Monitor or Configuration |
| `#add` | Add a backend |
| `#setup/<type>` | setting up a backend of that type |

- The page moves between its own views with `pushState` and its own
  listener. BB's `UrlLink` to the same page changes the URL without telling
  the page, so the page never uses it for its own views.
- Links from other parts of bb-box that may be on screen while the
  settings page shows use `SettingsLink`: a real link to the settings page
  with the hash, which, when the settings page is already open, calls
  `openSettingsView` instead. That pushes the hash and sends an event the
  page listens to.
- The page also reads the hash again when the window regains focus or
  becomes visible, and on `hashchange`.
- Back and forward walk the views. Reload keeps the view. Leaving by BB's
  sidebar and coming back with back returns to the view.
- A hash for something that is not there, such as `#kind/no-such-kind` or a
  removed backend, shows "This kind is not here", with Go to BB Box settings.
  It is never a blank page.

Every inner view starts with one row: where you are ("BB Box settings ›
Proxmox LXC", the first part going to the overview), and, when the person
came from another inner view, "Back to …".

Opening a view moves focus to its heading. Going back puts focus on the row
the person opened and the scroll where it was. Pages change in place,
with no slide. After a new backend is saved, its setup view is replaced in
history by the backend's page, so back never returns to an empty setup
form.

## The overview

In order:

1. First run, while no backend is on, or the setup job's progress once one
   is (`first-run.tsx`, today's guidance).
2. **Status**: one line that is never more certain than the checks, and a
   callout of everything that needs the person, each with its fix and Open.
3. **Backends**: one row each, with its icon, name, a host chip, a "BB
   machine" chip for Docker or microsandbox on one of your BB machines, one
   state line, and the "takes new boxes" switch. The host chip is the host
   the built backend names, as the Box panel and `box_list` do: a BB
   machine by its name, a Docker daemon by its own name, the Proxmox node,
   Tart's Mac or how many Macs. A backend not built, as one not finished, takes it from
   its fields: the Proxmox node (or its API URL's host), Tart's Mac or how
   many Macs, the Docker or microsandbox host ("this machine" for BB's
   server), or how many machines an SSH host pool lists; else the name in a
   second backend's ID. While its page has a draft the row says "Unsaved
   changes", and "Saving…" while a save of it is out. Add backend is beside
   the title.
4. **Kinds**: one row each, in one list with no group headings, Linux kinds
   first, then macOS and iOS, then Windows and Android, with the kind's full name, a Default chip, its default
   size, how many backends make it, warm and spare counts, and the
   "offered to threads" switch. Kinds that are off, and kinds no backend
   you have makes, fold into one line. A kind switched off on this visit
   stays in place, dimmed, until the person leaves the page.
5. **Options**: Boxes, Images, Devices, Network, Monitor (with its switch
   on the row), Configuration, and Your machines, which opens the Boxes
   page on its Machines tab.

On every row a switch sits at the right, just before the chevron, and the
chevron is always the last thing on the row. Rows without a switch keep no
space for one: their value sits close to the chevron. The whole row opens
its page; the switch acts on its own.

### Status words

| State | Backend row | Status |
| --- | --- | --- |
| Off | "Off · takes no new boxes" | counted as off |
| Not finished: saved off with problems | "Not finished" and what is missing | listed, with Open |
| Not checked yet | "Not checked yet" | counted |
| Not checked since it changed: its settings changed after the revision its last check tested | "Not checked since it changed" | counted, and Check all becomes the main button |
| Last check passed, over an hour ago | "Last check passed · 6 hours ago" | "passed their last check", with the range of ages |
| Ready: passed within the hour | "Ready" | "All 3 backends ready" |
| Passed with warnings: no check failed, some warned | "Last check passed, 4 warnings" or "Ready, 4 warnings", in a pass's tone; the page lists the warnings first | counted as passed, not listed |
| Not working: a failure, or settings with a problem | red, with the failure | listed with its fix |

When every check has the same age, rows drop it and Status gives it. Check
all runs each backend that is on, side by side, up to 30 s each, and
becomes the main button when any check is over an hour old, missing, or
older than the backend's last change.

Most warnings are notes, so a pass with warnings never says "Needs
attention", and never hides them either.

The callout lists backends that fail, backends saved but
not finished, warm pools short for want of room, the default kind turned
off, and kinds that backends that are on cannot make now.

## Saving

The rule, on each page with a form: "Switches, and menus that stand alone,
act at once. Fields, checkboxes and radio choices wait for Save."

Every write goes through one path, the draft registry in
`settings-drafts.ts`, which lives outside the page's components, so it
outlives them. Each write is an operation with an ID the page makes, and
each is confirmed only by BB Box's reply or its receipt.

### Forms

The Boxes page's Boxes per thread, its files for every box, the
Monitor's Refresh every, and each backend's page are forms on the
registry. Other pages keep the forms they had before 067 until their
units.

- An edit is a setting's path, such as `monitor/refreshIntervalSeconds`,
  `files/<path>`, `backends/<id>/fields/<key>` or
  `backends/<id>/hosts/<name>/fields/<key>`, with the value typed and the
  stored value it started from: a file's content and a secret start from
  their version.
- A changed field has a "Changed" chip. The bar says "1 change to the
  Monitor not saved", with Discard and Save. Enter in a field saves.
- A change made elsewhere to another setting shows as stored. A change
  made elsewhere to a setting edited here is a conflict on its row at
  once: "Changed elsewhere to 8 while you edited", with Use theirs and Keep
  mine; for a file, "Replaced elsewhere while you edited, at revision 216",
  with Keep the saved one and Keep mine. Save waits until each is chosen,
  and Show focuses the first.
- Save freezes the part's edits as the operation's submission. It sends
  them applied to the latest configuration the page has, with its
  revision. When someone saved first, it checks the submission against
  the newer configuration the refusal carries, and saves on it or stops
  with the conflicts; after 3 refusals in a row it stops: "Not saved: the
  configuration changed three times while saving. Your changes are still
  here."
- Typing during a save is a change of its own. Only edits still as sent
  are cleared: "Saved. Your newer change is not saved yet."
- When BB Box does not reply, the page looks for the save's receipt: with
  it, "Saved at revision 215. The reply was lost; BB Box's receipt for this
  save confirms it"; without it, "Save not confirmed: BB Box has no receipt
  for it yet … Saving again resends the same request, which BB Box applies
  at most once." Save again sends the frozen submission with its first ID.
  A save older than the receipts BB Box keeps is never sent again, and is
  said as not confirmed.
- After a confirmed save, the bar names what changed elsewhere since:
  "Since then, changed elsewhere: the content of ~/.cfg/a.json (revision
  216)".
- A new file has a provisional identity, such as `files/@new-k3x9`, until
  its save is confirmed; then its edits move to `files/<path>`. A new Mac
  is `backends/tart/hosts/@new-k3x9` in the same way, and its fields'
  edits, typed while its save was out included, move to the Mac it made. A new file
  given the path of a file already there replaces it, from that file's
  version: "~/.cfg/a.json is already a file here. Saving replaces it." An
  empty or wrong path is refused at its field.
- Leaving the page keeps the draft, and the overview marks the option's
  row "Unsaved changes". A save still out completes in the registry, and
  the page shows its state on return. Each part's edits, without file
  contents, and its pending save are kept in session storage; file
  contents are kept in memory only. After a reload: "Your unsaved changes
  to files for every box are back: 1 change. For safety the content of
  ~/.cfg/a.json you pasted was not kept; paste it again." Closing or
  reloading the tab with a draft asks first.

### Switches, menus and removals

A switch, a menu that stands alone such as the default kind, and removing
a file are operations of one change, sent at once. Removing a file asks
first and says what follows.

- It says "Saved" beside it for 1.6 s, only once BB Box confirms it.
- A refusal puts it back and says why under its row: "Fake host was not
  changed: Set the API token."
- When someone saved first, it tries again on the newer configuration, at
  most 3 times. If that already has the value: "Already off: changed
  elsewhere at revision 216". After 3 refusals: "… was not changed: the
  configuration changed 3 times while saving. It is on; try again."
- When BB Box does not reply and has no receipt: "Not confirmed: BB Box did
  not reply (…), and has no receipt for this change. Fake host is on now,
  at revision 215." A receipt found later says so.
- Docker on one of your BB machines switches through `docker.host.set`,
  with its operation ID, which builds its images.

Each other part's page holds today's form for it, as it was before 067,
until a later unit replaces it: setting up a backend, with Save, Save and
turn on, Check and the last report; a kind's editor; Rebuild now. These save the whole document with their Save, and a stale
revision reloads and says so.

## A backend's page

- **Header**: its icon, name, host chip, "BB machine" chip, description,
  "Saved changes reach new boxes; boxes already made keep theirs", the
  saving rule, the "takes new boxes" switch, and a menu: Rename…, Copy
  saved settings as JSON (each secret as whether it is set), Open the
  setup guide, and Remove backend…. Rename acts at once. Remove asks,
  naming the secrets it deletes, and is refused while the backend has
  boxes: the menu says "Remove: release its 1 box first", and a refusal
  that races a new box says "Docker was not removed: …" under the header.
- **Health**: the same state as its row, from the revision its settings
  last changed at and the revision its last check tested: "Not checked
  since it changed" and how that check went, "2 of 6 checks passed ·
  checked 6 hours ago, so it may have changed since", "Not finished" with
  what is missing. Failed checks and warnings come first with their fixes,
  then the notes; passed checks fold. Check runs its checks against what is
  saved; with a draft, "Check with my changes" runs them against the same
  candidate Save would send, a new Mac and a pasted secret included. That
  result is bound to the revision and a hash of the edits, and any later
  edit clears it: "Your form changed after you checked it, so that result
  was cleared. Check again."
- **In use**: boxes now, the kinds it makes (each a link), and warm boxes,
  with "0 of 1 Linux ready: no room" where a pool is short.
- **Cards** in the driver's groups: Connection, Credentials, Boxes, Shared
  iOS hosts and Advanced. The last two fold, with a summary such as "Off ·
  All at their defaults", and open by themselves when they hold an edit, a
  conflict or a problem. A BB machine's Docker keeps its host to itself.
- **Each field** shows the first sentence of its help (`helpParts`), with
  More for the rest, a Changed chip, its problem (from the last save, or
  the stored configuration's) and its conflict. An empty field shows the
  value it takes inside it and under it: "Empty: 4096, the default",
  "Empty: https://…, from Proxmox LXC". A field where empty turns boxes off
  has an Offer checkbox: unticked, it is saved empty, so off, and says so.
  On-or-off fields are checkboxes. A secret says Set or Not set and offers
  Set or Replace and Clear; its conflict names the revision that replaced
  it.
- **Macs**, for Tart: a row each, with its address, its switch, which acts
  at once, and its chevron last. A row opens to its address, user, host
  keys and "Its own shared iOS host size", each empty size saying what it
  takes: "Empty: 6 cores, Tart's setting" or "Empty: 4 cores, bb-box's
  estimate for mac-1". The estimate is from what bb-box last read of the
  Mac; a Mac it has not read yet is read in the background when the page
  asks, at most once a minute. Add Mac stages a new Mac, named in its
  first field, with "Takes boxes"; a name already on the backend is refused
  at its field before anything is sent. Remove… asks and stages the
  removal until Save.
- **The bar** has Check beside Discard and Save. Save stays on the page.

## Each page

| Page | Holds |
| --- | --- |
| A backend | See [A backend's page](#a-backends-page). For Docker on a BB machine, the Docker on BB machines list follows the cards |
| A kind | Header with its full name, badges, description, Make default, and the "offered to threads" switch; the default kind's switch is disabled, with why. Then its editor: sizes, the default size, largest size, warm boxes per backend and spares |
| Boxes | Default kind (a menu that acts at once); boxes per thread; boxes join BB as machines and Linux desktops as video (switches); Files for every box |
| Images | Rebuild each night (a switch); Rebuild now; the names of projects' images, set with `bb box image set` |
| Devices | Streaming: iOS video encoding, a menu, and "Share each Mac's encoder fairly", a switch, both at once. Set on other pages: each backend's shared iOS hosts, and each device kind's spares with "None, as by default" and why they are off by default, each opening its page. For testing: the test device, a switch |
| Network | The tailnet as one form on the engine: whether machines join (two radio choices), tags (empty for `tag:bb-box`), and the OAuth client ID and secret, Set or Replace, with their versions. Saved together with one Save, or Enter; a refusal keeps every change, with the reason under the field it names. Choosing No hides the rest, drops their edits and says "Saving No deletes the saved OAuth client ID and secret" |
| Monitor | Machine status (a switch, also on its overview row), Refresh every … s, background monitoring and pressure notifications. After machine status changes: "The sidebar's machine status changes when BB next loads", with Reload BB now |
| Configuration | The revision and what happens when two people save; the `bb box config` commands |
| Add a backend | Every driver, each with what it is; one already added says "Added: open it". Then Docker on BB machines, every machine with Docker's state and its switch |
| Set up a backend | The driver's guide and setup form, with Save and turn on |

## Keyboard and screen readers

- Every row, link and button has a visible focus ring.
- Every switch has a name of its own, such as "Linux desktop (GPU):
  offered to threads" or "Proxmox LXC: takes new boxes", with its row's
  state as its description. Kinds are named in full; two kinds with one
  label are told apart as (GPU) and (CPU).
- Status, Saved, switch notes, the save bar and conflicts are live
  regions. Help, problems and conflicts are tied to their field with
  `aria-describedby`, and a field with a problem is marked invalid.
- While it saves, Save stays focusable and ignores presses; when the bar's
  buttons go, focus stays on the bar's words.

## Machines

Your machines (036) are on the Boxes page's Machines tab, which has every
action they had here, through the shared `MachineRow`. The Options row
opens that tab, empty or not, through the Boxes page's sub-path
`machines`. A thread's Box panel says of its own machine "Remove or stop it
on the Boxes page, under Machines".

## As built

| Unit of 067 | State |
| --- | --- |
| 1: views and the hash, the overview with its rows, switches and Status, the option pages, Machines to the Boxes page; each part's page opens today's form | Built |
| 2: the editing engine on Boxes and Monitor, and every switch on it | Built |
| 3: each backend's page on the engine, with health, In use, cards, Macs and the menu | Built |
| 4: the drivers' help text | Built |
| 5 to 8: Docker on BB machines as backends, kind pages, first run, Images | To come, as 067 lists them |
| 9: Devices and Network on the engine | Built |
| 10 and 11: Configuration, Find | To come, as 067 lists them |

The code: `src/app/settings.tsx` (the view: hash, focus and scroll),
`settings-route.ts` (views, hashes and `openSettingsView`),
`settings-link.tsx`, `settings-nav.ts` (history entries), `settings-status.ts`
(state words, Status and the callout), `settings-drafts.ts`,
`settings-paths.ts` and `settings-saving.tsx` (the engine),
`settings-checks.ts` (checks bound to a form), `settings-backend-page.tsx`
and `settings-backend-fields.tsx` (a backend's page),
`settings-tailnet.tsx` (Network), `settings-context.tsx`,
`settings-overview.tsx`, `settings-pages.tsx` and `settings-parts.tsx`.
Today's forms stay in
`settings-backends.tsx`, `settings-kinds.tsx`, `settings-fields.tsx`,
`settings-files.tsx`, `settings-docker-hosts.tsx`,
`rebuild-now.tsx` and `first-run.tsx`, with the helpers in `config.ts`.
