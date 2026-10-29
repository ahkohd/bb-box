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
| `config.apply(draft, revision)` | one checked write; refused when the revision moved on or a field is wrong |
| `docker.host.set(hostId, enabled)` | Docker on one of your BB machines on or off, with its images |

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
  page listens to. The Monitor panel's settings button is one.
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
   machine" chip for Docker on one of your BB machines, one state line, and
   the "takes new boxes" switch. Add backend is beside the title.
4. **Kinds**: one row each in three groups (Linux; macOS and iOS; Windows
   and Android), with the kind's full name, a Default chip, its default
   size, how many backends make it, warm and spare counts, and the
   "offered to threads" switch. Kinds that are off, and kinds no backend
   you have makes, fold into one line. A kind switched off on this visit
   stays in place, dimmed, until the person leaves the page.
5. **Options**: Boxes, Images, Devices, Network, Monitor (with its switch
   on the row), Configuration, and Your machines, which opens the Boxes
   page on its Machines tab.

### Status words

| State | Backend row | Status |
| --- | --- | --- |
| Off | "Off · takes no new boxes" | counted as off |
| Not finished: saved off with problems | "Not finished" and what is missing | listed, with Open |
| Not checked yet | "Not checked yet" | counted |
| Not checked since it changed: its settings changed after the revision its last check tested | "Not checked since it changed" | counted, and Check all becomes the main button |
| Last check passed, over an hour ago | "Last check passed · 6 hours ago" | "passed their last check", with the range of ages |
| Ready: passed within the hour | "Ready" | "All 3 backends ready" |
| Needs attention: a warning | amber, with the warning | listed with its fix |
| Not working: a failure, or settings with a problem | red, with the failure | listed with its fix |

When every check has the same age, rows drop it and Status gives it. Check
all runs each backend that is on, side by side, up to 30 s each, and
becomes the main button when any check is over an hour old, missing, or
older than the backend's last change.

The callout lists backends that fail or need attention, backends saved but
not finished, warm pools short for want of room, the default kind turned
off, and kinds that backends that are on cannot make now.

## Saving

The rule, on each page with a form: switches, and menus that stand alone,
act at once; fields wait for their Save.

A switch, or a menu that stands alone, such as the default kind, sends the
latest document with that one change and the revision it was read at.

- It says "Saved" beside it for 1.6 s, only once BB Box confirms it.
- A refusal puts it back and says why under its row: "Fake host was not
  changed: Set the API token."
- When someone saved first, it takes the newer document the refusal
  carries and tries again, at most 3 times. If the newer document already
  has the value, it says "Already off: changed elsewhere at revision 216".
  After 3 refusals in a row it says "… was not changed: the configuration
  changed 3 times while saving. It is on; try again."
- When BB Box does not reply, it reads the configuration again and says
  "Not confirmed: BB Box did not reply (…). Fake host is on now, at
  revision 215." A reply that never came is never called saved or failed.
- Docker on one of your BB machines switches through `docker.host.set`,
  which builds its images.

Each part's page holds today's form for it, as it was before 067, until a
later unit replaces it: a backend's setup form with Save, Save and turn on,
Check and the last report; a kind's editor; the tailnet's form; Files for
every box; Rebuild now. These save the whole document with their Save, and
a stale revision reloads and says so. Boxes per thread and Refresh every
save when the field is left, or on Enter.

## Each page

| Page | Holds |
| --- | --- |
| A backend | Header with its icon, name, chips, description, "Saved changes reach new boxes; boxes already made keep theirs", and the "takes new boxes" switch. Health: its state, its last check's age, its fix; boxes now and the kinds it makes. Then its setup form, or for Docker on a BB machine the Docker on BB machines list |
| A kind | Header with its full name, badges, description, Make default, and the "offered to threads" switch; the default kind's switch is disabled, with why. Then its editor: sizes, the default size, largest size, warm boxes per backend and spares |
| Boxes | Default kind (a menu that acts at once); boxes per thread; boxes join BB as machines and Linux desktops as video (switches); Files for every box |
| Images | Rebuild each night (a switch); Rebuild now; the names of projects' images, set with `bb box image set` |
| Devices | iOS video encoding, sharing each Mac's encoder fairly and the test device, as values, with how to change them with `bb box config`; each device kind's spares, linked |
| Network | The tailnet: whether machines join, tags, OAuth client ID and secret, saved together |
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
- Status, Saved and switch notes are live regions.

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
| 2 and later: the editing engine, backend and kind pages of their own, Docker on BB machines as backends, first run, Images, Devices and Network, Configuration, Find | To come, as 067 lists them |

The code: `src/app/settings.tsx` (the view: hash, focus, scroll, motion),
`settings-route.ts` (views, hashes and `openSettingsView`),
`settings-link.tsx`, `settings-nav.ts` (history entries), `settings-status.ts`
(state words, Status and the callout), `settings-instant.ts` (the at-once
write path), `settings-context.tsx`, `settings-overview.tsx`,
`settings-pages.tsx` and `settings-parts.tsx`. Today's forms stay in
`settings-backends.tsx`, `settings-kinds.tsx`, `settings-fields.tsx`,
`settings-files.tsx`, `settings-tailnet.tsx`, `settings-docker-hosts.tsx`,
`rebuild-now.tsx` and `first-run.tsx`, with the helpers in `config.ts`.
