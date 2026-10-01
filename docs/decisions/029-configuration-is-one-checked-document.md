# 029: Configuration is one checked document in bb-box's storage

Status: accepted, 1 October 2026. Partly supersedes
[027](027-a-kind-says-when-it-has-a-desktop.md): how the settings keys from
before 027 are read.

## Context

bb-box's configuration is BB plugin settings today: flat keys that each
driver declares, such as `proxmox-lxc-url`. BB shows them as generic fields
on bb-box's page in Tools, and cannot group or hide them. The operator asked
for a real settings page: a part per backend with a guided setup, switches
for backends and kinds, the presets per kind from
[028](028-a-box-size-is-chosen-when-it-is-made.md), and a check that a
configuration works before it is saved. Configuration is also scripted
today, by writing BB settings, so it must work without the browser.

What BB gives a plugin:

- Declared settings. A string can be `secret: true`: BB keeps it in a 0600
  file in the plugin's data directory, never in bb.db, and never sends it to
  the browser. The settings handle reads and writes declared keys only, and
  gives a key's declared default when it is unset.
- A `settingsSection`, bb-box's own component on the same page, shown beside
  any declared settings.
- Plugin storage: JSON values of up to 256 KB in bb.db, or the plugin's own
  SQLite file. bb-box keeps its install ID and the SSH key it generates
  there already.
- `bb plugin remove` deletes a plugin's settings, secrets and storage alike.

An operator may have several Docker hosts, or several Macs for Tart, that
are set up alike, and one Proxmox host. Each backend has one instance today,
whose ID is its type.

## Decision

### Where it lives

- bb-box's configuration is one JSON document in its plugin storage, with a
  schema version and a revision. Only bb-box's RPC and CLI write it, and
  every write is checked first. bb-box declares no BB settings once the
  document exists, so its page in Tools shows only bb-box's own section.
- The document holds what the operator set. A value left out takes the
  default bb-box ships, so a later release's default reaches it.
- Secrets, such as the Proxmox API token secret and SSH private keys, are in
  plugin storage under a key of their own, apart from the document. They are
  write-only: the page and the CLI say only whether each is set.
- Who can read them: anyone who can read bb.db, which is BB's OS user, root,
  any plugin in BB's server, and anyone with a copy of bb.db, such as a
  backup. BB's secret settings differ only in that last point. bb-box's
  generated SSH key is kept this way already.
- Secrets do not stay as BB's secret settings, because each would be a field
  on the page outside bb-box's section: a second place to set it, which
  skips the check. Declared keys are also fixed when the plugin loads, so
  they cannot follow a list of backends. If an install needs secrets out of
  bb.db later, they can move to the plugin's own SQLite file without
  changing the page or the CLI.

### Backends and their hosts

- The document lists the backends in the order the registry tries them. Each
  has an ID, a type (its driver), a display name, a switch, its fields, its
  warm counts per kind, and its hosts if it has any.
- Hosts that are set up alike are a list inside one backend: Docker hosts,
  Tart's Macs, and later a Proxmox cluster's nodes. Each host has a name, an
  address, a user, pinned host keys, a jump host if needed, and a switch.
  The backend shares one login key across its hosts. A new box goes on the
  first host in the list with room, so the list's order is a preference,
  and `Guest.host` names the host.
- Separate backends of one type are for configurations that differ in kind,
  such as two Proxmox hosts that are not one cluster. The first backend of a
  type keeps the type as its ID, so box records, backend storage
  (`backend/<id>/`) and guests stay as they are. Another is `<type>:<name>`,
  with a name of lower-case letters, digits and `-`. bb-box builds one
  backend per type at first; the document allows more.
- A backend's or host's name cannot change, and it cannot be removed, while
  it has boxes. Turn it off and release them first.
- An SSH host pool's machines and physical Macs are members of their pool,
  not hosts: each machine is a box.

### Switches

- A backend, a host and a kind each have a switch. Off stops new boxes only:
  boxes already there keep working, can be stopped, started and released,
  and the sweep looks after them. An off backend or kind keeps no warm
  guests.
- So an off backend whose fields are valid stays built. Today core disposes
  it, and its boxes fail with `backend_off`; that is now only for a backend
  whose fields are not valid.
- A kind is offered where it is on, its backend is on, and the backend can
  make it.

### What else the document holds

- For each kind: its switch, its presets, its default preset and its
  largest custom size (028).
- Warm counts per backend and kind. A backend whose kinds share warm guests,
  as Proxmox LXC's `linux` and `linux-docker` share a template, keeps their
  sum.
- General: boxes per thread, whether boxes enrol, and the default kind.

### The RPC

- `config.get` gives the document, the defaults, which secrets are set, each
  part's problems, the revision, and each backend's state (active, off or
  misconfigured) with its last doctor report and when it ran.
- `config.check(draft, {test})` gives problems keyed by field path, such as
  `backends.proxmox-lxc.url`, and saves nothing. With `test`, it also builds
  a backend from the draft, runs only its doctor, for at most 30 s and with
  no acquire or maintain, then disposes it.
- `config.apply(draft, revision)` saves the whole document at once, then
  reconfigures the backends and tells open panels and pages. It refuses:
  - a revision that is not the current one, and gives the current document;
  - problems in the general or kinds part, or in a backend that is on or has
    boxes. An off backend without boxes can be saved with problems, so a
    guided setup can stop part way.
- In a draft, a secret left out or given as `{"set": true}` keeps its stored
  value, a string replaces it, and null clears it.
- Drivers give their setup guide and scripts as paths in the repository.
  Core makes the links from one repository URL.

### The CLI

- `bb box config show` prints the configuration, and `--json` prints the
  document, with each secret as `{"set": true}` or `{"set": false}`. That is
  the export: keep it to set bb-box up again after `bb plugin remove`. It
  holds no secret, so it is safe to print, keep and share.
- `bb box config check <file> [--test]` and `bb box config apply <file>` do
  what the RPC does, with the document in the file. A revision in the file
  must be the current one; a file without one, or a store without a
  document, is applied over what is there. The command runs in BB's server,
  so the file is read on that machine.

### Moving from BB's settings

On the first start of the version that brings the document, if there is no
document, bb-box builds it from BB's settings:

- Each key's value, reading a key from before 027 where its new key is unset
  (027). A value equal to its declared default is left out.
- Proxmox LXC's cores, memory and disk per flavour become the default
  preset's size for the flavour's kinds (028). Its warm count per flavour
  becomes the count for the flavour's first kind.
- Proxmox LXC is in the document, with ID `proxmox-lxc` and its switch as it
  was, if any of its keys was set. Its boxes, storage and guests carry over,
  and no guest is touched. A new install starts with no backends.
- The secrets are written first, then a copy of the non-secret values
  BB's settings gave, then the document at revision 1. The document marks
  the move as done, so it happens once, and a failed write leaves BB's
  settings as they were for the next start to try again.
- The copy is kept in plugin storage under
  `config/migrated-from-bb-settings`, with the time of the move and the
  bb-box version that made it, so a value that moved wrongly can be
  compared with what it was. `bb box config migrated` prints it, and
  `--remove` removes it. `bb box config show` mentions it until then.
  Secrets are not copied: they exist on their hosts.
- Then bb-box clears the old values from BB's settings, so no second copy of
  a secret is left, and marks them cleared in plugin storage. It declares
  the old keys only until that mark is there, so a start cut short after
  the document is written clears them on the next start. Clearing them
  must not reconfigure the backends: once the document exists, BB's
  settings never drive them.

## Consequences

- One place sets everything, and every write is checked. bb-box's page in
  Tools shows only its own section from the next start.
- Drivers change shape. Their settings become fields named within the
  backend, in the shape of BB's setting descriptors with a group
  (`connection`, `credentials`, `boxes` or `advanced`), shown in the order
  they are declared, plus fields per host for a backend with hosts.
  `parse` reads the backend's part of the document and gives each problem
  with its field. `create` gets the backend's ID. Drivers ship no UI: the
  page renders their fields.
- Core changes: an off backend stays built, hosts and kinds get switches,
  and the registry's order comes from the document.
- Backends that land before the document declare BB settings as today, and
  the move reads their keys too.
- After `bb plugin remove`, the export sets bb-box up again, and the secrets
  are given again, in the file or on the page. Going back to a version
  before this one needs BB's settings set again.
