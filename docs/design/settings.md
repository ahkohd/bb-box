# Design: the settings page

bb-box's page under BB's settings, where a person turns backends and kinds
on and off and sets them up ([#59](https://github.com/moonstead/bb-box/issues/59)).
The panel design is in [panel.md](panel.md); the mockups in
[mockups](mockups/) include the settings screens.

## Why

BB draws a plugin's declared settings as one generic form. For bb-box that
is about thirty fields named "Proxmox LXC: ...", with no grouping, no
guidance and no way to tell what is set up and what is missing. Below it
sits bb-box's own section with the backends' states and a doctor button.
The operator asked for a page "to enable or disable stuff or set stuff up"
(1 October 2026).

## Where configuration lives

Decided with the architect ([decision 029](../decisions/029-configuration-is-one-checked-document.md),
which records the detail): configuration is one versioned
document in the plugin's storage, written only through bb-box's RPC and
CLI, and bb-box declares no BB settings once the document exists. BB's
page for bb-box then shows only this page. Secrets live in the document
too and never come back to the browser: the page shows whether each is set.

The RPC the page uses:

| Call | Does |
| --- | --- |
| `config.get` | the document, each secret as set or not, each part's problems, a revision, and each backend's live state and when it was last checked |
| `config.check(draft, { test? })` | problems keyed by field path, without saving; with `test`, a backend's doctor against the draft, within 30 s |
| `config.apply(draft, revision)` | one checked write; refused when the revision moved on or a field is wrong; a secret left out keeps its value and `null` clears it; returns the new document |

Switches apply at once. Text fields save with one "Save" per backend, so a
half-typed URL never reconfigures anything. The page refetches on bb-box's
change signal.

## Layout

Three sections under BB's plugin header (name, description and the
plugin's own on-off switch, which BB draws). Each section has BB's section
title and description, and a card with rows divided by hairlines, as BB's
Machines page does.

### Backends

```
Backends
Where boxes come from.
+--------------------------------------------------------------------------------+
| Proxmox LXC  [pve]                                       [Check] [Set up v] (on) |
| (green) Ready · Proxmox VE 9.2 on pve · 3 kinds on offer · checked 2 min ago   |
|--------------------------------------------------------------------------------|
| Docker                                                        [Set up >] (on)  |
| (amber) Needs setting up · Set the Docker host.                                |
|--------------------------------------------------------------------------------|
| SSH host pool                                                 [Set up >] (off) |
| (ring) Off · Your own machines, reached over SSH and reset between boxes.      |
+--------------------------------------------------------------------------------+
```

- One row per backend, with its display name and, for a second backend of
  one type, its short name as a chip. The rows are the drivers bb-box has,
  so a new backend appears here with its switch off and its own description.
  A backend set up on several machines alike (Docker on two hosts, Tart on
  several Macs) is one row whose hosts are listed in its setup area; a new
  box goes to the first host with room, so their order is a preference.
- **Switch**: on or off. Off stops new boxes only; existing boxes keep
  working and can be released, and the backend keeps no warm boxes. A
  backend cannot be renamed or removed while it has boxes.
- **State line** in BB's status style: Ready with its summary ("Proxmox VE
  9.2 on pve"), how many kinds it offers and when it was last checked;
  Needs setting up with the first problem; Off with one line saying what
  the backend is for.
- **Check** runs the backend's doctor and shows the results inside the
  row's setup area (below). The state line's "checked 2 min ago" comes from
  the last run.
- **Set up** opens the row's setup area. A backend that needs setting up
  opens it on the first visit.

### A backend's setup area

```
Follow the Proxmox LXC setup guide. Its scripts print the values for this form.

API URL                    Node
[https://192.0.2.10:8006]  [pve]
API token ID               API token secret  [secret] [not set]
[bbbox@pve!plugin]         [Paste the secret]
TLS fingerprint            Resource pool
[AB:CD:EF:...]             [bbbox]

Templates
Linux templates            GPU desktop templates
[9100]                     [9101 GPU-0a1b2c3d]
VMIDs, separated by        One per line: VMID and the GPU's ID.
spaces. Serve Linux and
Linux with Docker.
CPU desktop templates      SSH key  [secret] [set]  [Replace]
[ ]
Leave empty to offer no CPU desktops.

> Network, addresses, VMIDs and reserves          (folded)

[Save]  [Check]

(ok)   Proxmox API      Proxmox VE 9.2 on pve
(ok)   Token rights     VM.Allocate, VM.Clone, VM.Config.*, VM.PowerMgmt on /pool/bbbox
(fail) Template 9101    has no tag build:..., so warm boxes cannot be checked against it.
                        Fix: run build.sh desktop again; it tags the template.
(warn) Memory           pve has 6 GiB free; 4 GiB is kept back, so one Linux box fits.
(skip) SSH into a box   skipped, since a template check failed.
       Install this public key in the templates:
       ssh-ed25519 AAAA... bb-box                                     [copy]
```

- **The guide first.** The first line links the backend's setup guide (the
  driver's `setup.guide`, as a page in the repository), as decision 016
  asks.
- **Fields in the order the guide produces them**: connection, then
  credentials, then templates (or images, or pool members), each with its
  description under it in BB's subtle text. Labels drop the "Proxmox LXC:"
  prefix, since the row already says which backend this is.
- **Secrets** show a "secret" chip and "set" or "not set". A set secret has
  no field, only "Replace" (which shows a field for a new value) and
  "Clear". A not-set secret has an empty password field. Values never
  round-trip.
- **Hosts**, for a backend that has them: a row per host with its name,
  address, user and a switch, "Add host", and one login key for the backend.
  A host cannot be renamed or removed while it has boxes: "Turn it off and
  release its boxes first."
- **Advanced** fields (network, addresses, VMID range, reserves, SSH user,
  desktops per GPU) sit under one fold, closed by default, with the same
  layout.
- The fields come from the driver as descriptors in BB's own setting shape,
  each with a group (connection, credentials, templates, hosts, advanced)
  and an order, so the page renders any backend's form without knowing it.
  Defaults come with `config.get` and show as placeholders; the document
  holds only what the operator set.
- **Save** sends the whole document with this backend's edits through
  `config.apply`. Problems come back by field path and show under the field
  in destructive text; the first one is scrolled into view. A backend that
  is off and has no boxes can be saved with problems, so setting up can
  stop part way and resume; one that is on, or has boxes, cannot. A saved
  backend is reconfigured at once, and its state line updates.
- **Check** runs the doctor against the draft (`config.check` with `test`)
  without saving, so a person can test a token before committing it. Each
  check is a row with BB's icon for its status (check circle, warning
  triangle, cross, dash for skipped), its name, its detail in muted text,
  and its fix on a line below. Notes, such as a public key to install,
  come last in a monospace block with a copy button.

### Kinds

```
Kinds
What a thread can ask for. A kind is offered when it is on and a backend has it.
+----------------------------------------------------------------------------------------+
|      Kind                   From         Small       Medium      Large       Largest  Warm |
| (on) Linux [LXC]            Proxmox LXC  2 · 4 GiB*  4 · 8 GiB   8 · 16 GiB  16 · 32   0   |
| (on) Linux with Docker [LXC] Proxmox LXC 2 · 4 GiB*  4 · 8 GiB   8 · 16 GiB  16 · 32   0   |
| (on) Linux desktop [GPU] [LXC] Proxmox LXC 4 · 8 GiB* 8 · 16 GiB 16 · 32 GiB 32 · 64   1   |
| (off) Linux desktop [LXC]   Proxmox LXC ...                                                |
+----------------------------------------------------------------------------------------+
```

- One row per kind, with its switch, label, its badges (GPU where the kind
  takes one, then what its boxes are on the backends that offer it now: LXC,
  Docker, VM or Physical; see the panel design), the backends offering it, the three presets (cores · memory; the
  default marked), the largest custom size, and the warm count.
- Clicking a row opens its editor: three fields per preset (cores, memory
  GiB, disk GiB with "0 keeps the base disk"), which preset is the default,
  the largest custom size, and the warm count per offering backend. "Save"
  applies.
- A kind that is on but that no backend can make shows "Not offered: no
  backend has it" in warning text, and says which backend setting would
  provide it.

### General

| Row | Control |
| --- | --- |
| Default kind: what a thread gets when it does not say. | a menu of the kinds that are on |
| Boxes per thread: the most one thread may hold. 0 means no limit. | a number field |
| Enrol boxes as BB machines: a ready box joins BB, so threads and terminals can use it and it gets the thread's credentials. | a switch |

## States and copy

| Where | Text |
| --- | --- |
| section titles | Backends · Kinds · General |
| backend states | Ready · Needs setting up · Off · Checking… |
| state details | Proxmox VE 9.2 on pve · 3 kinds on offer · checked 2 min ago · Set the API token secret. |
| buttons | Check · Set up · Save · Replace · Clear · Copy |
| secrets | secret · set · not set |
| doctor | the check's `name`, `detail` and `fix` as the backend gives them, with "Fix:" before the fix |
| kinds | Small · Medium · Large · Largest · Warm · default · Not offered: no backend has it |
| off | Off stops new boxes. Boxes already made keep working. |

## As built

The page is one settings section with three blocks, Backends, Kinds and
General, titled as BB titles a plugin's sections. It reads `config.get` once
and on each change signal, and writes with `config.apply` against the
revision it read. A row's switch, a kind's switch and the general settings
save at once, each as the saved document with that one change. A backend's
setup area and a kind's editor hold their edits until Save, and send the
saved document with that backend or kind replaced, so two open forms never
overwrite each other. A stale revision reloads the page and says so; the
open form keeps its edits. `config.check` with the backend's ID runs the
doctor against the form without saving. The code is in
`src/app/settings.tsx`, `settings-backends.tsx`, `settings-kinds.tsx`,
`settings-fields.tsx` and the helpers in `config.ts`.

## A possible BB request

If BB later lets a plugin hide or group its declared settings, bb-box could
keep secrets in BB's own secret store and still own its page. Decision 029
does not need it, so no request is drafted; it is worth one once the page
exists and the trade-off can be shown.
