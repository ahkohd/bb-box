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
| `docker.hosts({ recheck? })` | each of your BB machines that could host boxes, with Docker as it answers, its image build and the fix for what stands in its way; `recheck` asks one machine again rather than taking what it said in the last minute |
| `docker.host.set(hostId, enabled, operation?)` | Docker on one of your BB machines added or turned on, with its images, and its receipt with an operation ID |
| `images.list` | the standard images bb-box rebuilds, each with its build and age, why it is due, and what its last rebuild did |
| `images.progress` | the rebuild going on, or the last one, image by image; and every failed rebuild: each standard image whose last rebuild failed, on a backend that is on, and each project image's failed build |
| `images.refresh` | starts a rebuild of what is due, as the night does; one going on is not doubled |
| `images.build(image)` | starts a rebuild of one standard image alone, due or not, as `bb box images build` does, with its progress; refused while a run goes on |
| `images` | the projects' images, with their projects' names, their builds and their failed builds |

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

1. First run, "Set up BB Box", until a backend that is on makes a kind:
   bb-box records that moment once as `setupDone`, so an established
   install whose backends are all off or failing keeps its overview, with
   "Every backend is off" or each failure in Status, and never the setup
   card again (`settings-first-run.tsx`, with `first-run.tsx`'s guidance).
   The card is titled for what it offers or what stands in the way: Use
   Docker on this machine, with the Linux image's build and then "Docker on
   this machine is ready" for an hour; "bb-1 has no Docker", with Docker's
   install line and a BB machine that has Docker; "BB cannot use Docker on
   bb-1", with the docker group line and the restart words; "Not enough
   disk on bb-1". Check again asks that machine's Docker again. Below it,
   "Finish setting up Proxmox LXC" for each backend saved off and not
   finished, then Choose another backend, which opens Add backend. Kinds
   and Options fold under "Sizes and options … for later", and Status
   waits until setup is done. Once it is, the setup job's progress shows
   above Status while a BB machine builds images, and Status names Docker
   on BB's server "Docker on this machine".
2. **Status**: one line that is never more certain than the checks, and a
   callout of everything that needs the person, each with its fix and Open.
   With every backend off, the callout's first item is "Every backend is
   off", with "Turn a backend on with its switch below" and Show, which
   moves focus to the first backend's switch.
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
   the title. A BB machine's Docker in use takes its state from the
   machine as well as its checks: "Offline in BB", or "Cannot host boxes"
   with why and its fix, and its image build on a second line. Under the
   list, one line names the machines whose Docker could host boxes, and
   those whose Docker cannot, with a link to Add backend.
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
off, kinds that backends that are on cannot make now, standard images whose
last rebuild failed, and projects' images whose build failed. The Images row
says how many failed.

## Saving

The rule, on each page with a form: "Switches, and menus that stand alone,
act at once. Fields, checkboxes and radio choices wait for Save."

Every write goes through one path, the draft registry in
`settings-drafts.ts`, which lives outside the page's components, so it
outlives them. Each write is an operation with an ID the page makes, and
each is confirmed only by BB Box's reply or its receipt.

### Forms

The Boxes page's Boxes per thread, its files for every box, the
Monitor's Refresh every, each backend's page, each kind's page, the
tailnet and setting up a backend are forms on the registry.

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
- Docker on one of your BB machines turns on through `docker.host.set`,
  with its operation ID, which checks its Docker answers and builds its
  images. It turns off like any backend, and stays a row; Remove
  backend… in its menu removes it.

### Setting up a backend

A new backend has a provisional identity until its first save, such as
`backends/proxmox-lxc@new-k3x9`, and its fields' edits sit under it, in
the part `setup/<type>`, so typing never depends on an ID that someone
else may take. Save writes one more edit, the new backend with the ID it
will be saved as (its type, or `docker:2` and on for a type that allows
several) and whether it is on. A backend added elsewhere with that ID is a
conflict, never saved over: for a type that allows several, Add mine
beside it takes the next free ID. Problems the server reports at
`backends.<id>.…` resolve to the provisional fields. On the receipt the
registry maps the provisional identity to the saved one, moves any edits
typed during the save to the backend's own part, `backend/<id>`, with the
saved values as their base, and the setup view is replaced by the
backend's page, which shows the save's outcome. A second Save there
updates the backend it made, and never makes another. Secrets typed in the
form are kept in memory only, as on every page.

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

## A kind's page

- **Header**: the kind's full name, its badges, "Default kind" when it is
  the default, its description, "Saved changes reach new boxes; boxes
  already made keep their size" and the saving rule. Then the Saved tick,
  Make default (a standalone action, at once, shown while the kind is on
  and not the default) and "Offered to threads" with its switch.
- **The default kind's rule**, the same on the overview's row and here: its
  switch stays on and cannot be turned off, but keeps focus and says why,
  "The default kind stays on. Choose another default to turn it off." The
  page shows that line with Choose another default, which opens Boxes with
  focus on the Default kind menu; the overview's Change the default does
  the same. A default kind that is off (an agent can do it) is a problem
  on the page and in Status, and its switch turns it on.
- **Sizes**: Small, Medium, Large and Largest by cores, memory in GiB and
  disk in GiB, with the default chosen by a radio in its own column. An
  empty disk keeps the image's own; Largest needs one. Below 640 px each
  size is a block with its three fields labelled and Default beside its
  name. A problem sits under its size, named, such as "Small: give the
  cores as a whole number, at least 1."
- **Where it runs**: each backend that makes the kind, in the document's
  order, which is the order a new box tries them. A backend is listed when
  its driver declares the kind, among its kinds or its `sharedKinds` (kinds
  it makes only on shared iOS hosts, as Namespace makes iOS boxes), or when
  it makes it now. Each row has its name (a link to its page),
  its form, whether it makes the kind now, is off, is set up not to make
  it, or cannot make it now (with why), its warm count and any shortfall.
  A warm count is offered only where the backend keeps warm boxes of the
  kind, as its driver's `warmKinds` says; elsewhere the row says "No warm
  boxes of this kind: it makes each box when a thread asks", or for iOS
  "No warm boxes: its shared iOS hosts keep slots ready instead", with a
  link to that card on the backend's page. A count stored where it does
  nothing stays editable and says so, so it can be set to 0.
- **Spare boxes**: Spares to keep, with how many are ready or being made.
  On device kinds it says spares are off by default and why.
- **One form** on the engine: the part `kind/<id>` writes
  `kinds/<id>/presets/<size>/<cores|memoryGiB|diskGiB>`,
  `kinds/<id>/largest/…`, `kinds/<id>/default`, `kinds/<id>/spares` and
  `backends/<backend>/warm/<kind>`, saved as changes from the shipped
  sizes. Memory is typed in GiB and stored in MiB. Enter saves.

A kind switched off on its page or the overview stays in its place on the
overview, dimmed, until the person leaves BB Box's settings.

## Each page

| Page | Holds |
| --- | --- |
| A backend | See [A backend's page](#a-backends-page). For Docker on a BB machine, a BB machine card follows Health: the machine, Docker's state and facts, its image build, and where it cannot host boxes, why, the lines that fix it and Check again |
| A kind | See [A kind's page](#a-kinds-page) |
| Boxes | Default kind (a menu that acts at once); boxes per thread; boxes join BB as machines and Linux desktops as video (switches); Files for every box |
| Images | See [The Images page](#the-images-page) |
| Devices | Streaming: iOS video encoding, a menu, and "Share each Mac's encoder fairly", a switch, both at once. Set on other pages: each backend's shared iOS hosts, and each device kind's spares with "None, as by default" and why they are off by default, each opening its page. For testing: the test device, a switch |
| Network | The tailnet as one form on the engine: whether machines join (two radio choices), tags (empty for `tag:bb-box`), and the OAuth client ID and secret, Set or Replace, with their versions. Saved together with one Save, or Enter; a refusal keeps every change, with the reason under the field it names. Choosing No hides the rest, drops their edits and says "Saving No deletes the saved OAuth client ID and secret" |
| Monitor | Machine status (a switch, also on its overview row), Refresh every … s, background monitoring and pressure notifications. After machine status changes: "The sidebar's machine status changes when BB next loads", with Reload BB now |
| Configuration | See [The Configuration page](#the-configuration-page) |
| Add a backend | Docker on your BB machines first: each machine that can host boxes with Docker's facts and Add; each whose Docker cannot, with why, the lines that fix it and Check again; each added, "Added: open it"; each offline; and one line for those with no Docker. Then every driver, grouped by where boxes run (on BB's server or a machine you have, on a Proxmox VE host, on your Macs, in the cloud), each with the kinds it makes and what setting it up needs, the driver's `setup.needs`. One already added says "Added: open it"; a type that allows several says how many are added and Add another |
| Set up a backend | Four numbered steps: 1, Prepare: the guide and what it needs, and its scripts in the order it runs them; 2, Connect: connection, credentials and Macs; 3, Choose what it makes: the kinds it can make and the Offer boxes left unticked; 4, Check it: all its checks against the form as it will be saved, up to 30 s, with nothing saved, the result cleared by any later edit. The bar offers Discard and go back, Save, keep it off, and Save and turn on; Enter saves nothing, as whether to turn it on is the person's choice. Saved on with a field missing is refused with the fields marked and nothing stored; saved off, it is stored and Not finished |

## The Images page

- **Standard images**: one line saying how many are due and what the last
  rebuild did ("The last rebuild ended 2 hours ago: 1 rebuilt, 1 waited for
  room, 1 failed."). Then Rebuild each night, a switch that acts at once,
  and a row for each standard image: its kind on its backend, and one state
  line. While a rebuild runs, or after one, the line is what the run did to
  it: Next, Rebuilding with its step, Rebuilt, Waits with why, Failed with
  why, Skipped, Not started. Otherwise it is its last rebuild's failure or
  wait, why it is due, or Up to date, with its build and age and its name
  for `bb box images build`. A row whose last rebuild failed has Try again,
  which rebuilds that image alone, even when nothing it is built from has
  changed, through the same run as Rebuild what is due.
- **Rebuild what is due**: "Rebuild 2 images", which starts the night's
  rebuild. While it runs, a bar shows how far it is, image by image and step
  by step, and it goes on if the person leaves. A run going on is not
  doubled: the button's refusal says why.
- **Projects' images**: a row each, with its name, its projects' names, its
  kinds and its builds on one state line, "When it is built ahead", a menu
  that acts at once (Built when used often, Always built ahead, Run at each
  box's start), and its chevron last. A row opens to where its files came
  from and when, each build and each failed build, its script and its
  check, and Remove…, which asks first and says what follows. A refusal
  says "The image rust-tools was not removed: …" under its row. Agents set
  them with `bb box image set`; the page shows and removes them.
- Removing a project's image, from the page or with `bb box config apply`,
  deletes its builds, as `bb box image remove` does: bb-box settles every
  project image that changed with each change of the configuration.

## The Configuration page

- **Revision**: the configuration's revision and what happens when two
  people save.
- **Export**: Copy as JSON and Download, the file `bb box config show
  --json` prints, with no secret in it. Under it, each secret that must be
  given again to set BB Box up from it, by where it lives.
- **Import**: a form on the engine, part `option/configuration`. The text
  is pasted or opened from a file, and kept in memory only, valid or not
  (067 R1). Check parses it in the page, then `config.check` with `read`
  answers with the file as bb-box reads it, with no secret value in it.
  The page turns each difference from the configuration into an edit of
  the engine, at the same paths as the other pages, so the change list
  says each change with its place, before and after; a secret or file
  content says only that it is replaced. Only those edits, without
  secrets, go into session storage. A change made elsewhere to a setting
  the import changes is a conflict on its row, with both choices; one to
  another setting stays. Apply is a save of the part: on a moved revision
  it applies the checked changes on the newer configuration, never the
  whole file over it. Text typed after Check clears the list; text typed
  while it applies stays, "Applied. Your newer text is not applied yet"
  (067 R4). A file that adds a file for every box without its content, or
  has a backend type this BB Box lacks, cannot be applied and says why.
- **Settings moved from BB**: while bb-box keeps the copy of BB's earlier
  settings, Remove copy… asks first, then `config.migrated.remove`; the
  page says it is removed only once BB Box answers, or once the
  configuration, read again, shows it gone.
- **From a terminal**: the `bb box config` commands.

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
| 5: Docker on BB machines as backends, rows and pages, and in Add backend | Built |
| 6: each kind's page on the engine, the default kind's rule everywhere, kinds kept in place | Built |
| 7: first run, Add backend and setting up a backend on the engine | Built |
| 8: Images, with every rebuild's run state, projects' images, and failed rebuilds in Status | Built |
| 9: Devices and Network on the engine | Built |
| 10: Configuration: export, import with its change list, the copy's removal | Built |
| 11: Find | To come, as 067 lists it |

The code: `src/app/settings.tsx` (the view: hash, focus and scroll),
`settings-route.ts` (views, hashes and `openSettingsView`),
`settings-link.tsx`, `settings-nav.ts` (history entries), `settings-status.ts`
(state words, Status and the callout), `settings-drafts.ts`,
`settings-paths.ts` and `settings-saving.tsx` (the engine),
`settings-checks.ts` (checks bound to a form), `settings-backend-page.tsx`
and `settings-backend-fields.tsx` (a backend's page), `settings-images.tsx`
and `rebuild-now.tsx` (the Images page),
`settings-kind-page.tsx` and `settings-kinds.tsx` (a kind's page, where it
runs, and the kind switch with the default kind's rule),
`settings-machine-docker.ts` and `settings-docker-hosts.tsx` (Docker on
your BB machines),
`settings-tailnet.tsx` (Network), `settings-configuration.tsx` and
`settings-import.ts` (Configuration, and an import's change list),
`settings-setup.tsx` (Add backend and
setting up a backend), `settings-first-run.tsx` (first run on the
overview), `settings-context.tsx`, `settings-overview.tsx`,
`settings-pages.tsx` and `settings-parts.tsx`. `first-run.tsx` keeps the
Box panel's first run and the guidance both share, `settings-files.tsx`
files for every box, and `settings-fields.tsx` the section and field
parts from before 067, with the helpers in `config.ts`.
