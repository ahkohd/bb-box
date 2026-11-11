# Each boat.dev account is a backend that labels what it makes

Status: accepted
Date: 11 November 2026

## Context

BB Box allowed one boat.dev backend. A boat.dev plan's limits, such as its
sandboxes at once and its starts, are per account, so a person with more
than one account could not add up their room ([#1455](https://github.com/ahkohd/bb-box/issues/1455)).
[087](087-each-namespace-workspace-is-a-backend-that-labels-what-it-makes.md)
let each Namespace workspace be a backend, and said boat.dev could follow
the same pattern.

A boat.dev backend found what it made by the install's label alone,
`bbbox-install`, and named its saved snapshots, its restores' deployed
sandboxes and its idempotency keys by the install alone. Nothing in the
configuration says which account a key belongs to, so two backends may
share one. Two backends of one install on one account would each have held,
renewed, swept and released the other's sandboxes, followed and deleted the
other's template builds, trials and old templates, listed and deleted the
other's saved snapshots, deleted the other's deployed sandboxes, counted the
other's sandboxes against their own Most boxes, and removed the other's
stale tailnet devices.

## Decision

- boat.dev allows several backends, as `boat`, `boat:team-b` and so on.
  Its driver's `several` names no host, so two may share an account and a
  key.
- Each sandbox a boat.dev backend makes, for a box, a template build or a
  template's trial fork, carries `bbbox-backend`, the backend's ID with `-`
  for `:`, beside `bbbox-install`. A backend lists, holds, renews,
  releases, sweeps, checks and tidies only sandboxes with its own label.
- The backend with the ID `boat` also owns sandboxes and templates with the
  install's label and no backend label, which earlier versions made. No
  other backend does. An install with one boat.dev backend so keeps its ID,
  boxes, sandboxes, templates, saved snapshots and kept snapshots, with no
  migration step. The first backend's names stay as they were: its saved
  snapshot names, deployed sandbox names, idempotency keys and tailnet names.
- Another backend's saved snapshots are named with the install's ID, then
  its label's value, then the box and the snapshot, such as
  `<install>-boat-team-b-bx...-sn...`. Its restores' deployed sandboxes,
  which boat.dev gives no labels, are named
  `bb-box:restoring:boat-team-b:<box>:<token>`, and its idempotency keys
  carry its label's value after the install. Each backend lists, keeps,
  deletes and cleans up only names of its own form.
- A backend forks only templates that a backend with its ID built, on this
  install or another BB Box install on the account, as one backend forked
  another install's before. So each backend builds its own templates, even
  where two share an account, and one backend's tidy never deletes a
  template another depends on.
- Most boxes counts the backend's own sandboxes, its template builds
  included, but not another backend's of the same install. The plan's
  sandboxes at once are the account's, and still count every sandbox on
  it; a refusal says how many are another backend's.
- What boat.dev bills for saved snapshots is the account's, and its free
  allowance is shared. Each backend's paid-snapshot ceiling is its own
  setting, and counts the account's bill, as before. Where two backends
  share an account, each one's ceiling so counts the other's saved
  snapshots too, which never counts less than the account pays.
- Another backend's boxes join the tailnet as `bb-box-boatb-`, the
  install's ID, the length of the backend's name, the name, then the box's
  name, as 087 does for Namespace. The first backend's prefix,
  `bb-box-boat-`, starts none of theirs. A boat.dev backend's name is so at
  most 13 characters, so its prefix fits a tailnet name with the longest
  install ID. A box's tailnet name that would still be too long is
  shortened with a code, as [094](094-a-tailnet-name-too-long-is-shortened-with-a-code.md)
  says, so 2 boxes of a backend never share one.
- A boat.dev backend is called boat.dev, and another by its name in
  brackets, such as boat.dev (team-b), in kinds, `on` and box_list.
- `bb box images list` lists each boat.dev backend's templates, through
  `Backend.ownImages`.
- What 087 and this record share, the labels, which backend owns what, the
  scope of names and the tailnet prefixes, is one class in
  `src/backends/labelled-owner.ts`, which each provider's owner extends with
  its own names.

## Consequences

- The first box of each kind on each boat.dev backend waits for its own
  template build, about 6 minutes for Linux and 13 for a Linux desktop,
  even where another backend shares its account.
- An install whose ID is another install's ID followed by `-boat-` and a
  name, such as `inst1-boat-team-b` beside `inst1`, would share saved
  snapshot names and idempotency keys with that install's backend of that
  name. Install IDs are made of random letters and digits unless set by
  hand, so this is left as 087 left it for Namespace's unique tags.
- A backend removed while its sandboxes still run leaves them to their
  auto-stop, as before. A sandbox without a backend label is no one's once
  the backend with the ID `boat` is gone.
- A backend kept for BB projects
  ([092](092-a-backend-can-be-kept-for-bb-projects.md)) can be any of them,
  as for any backend.
