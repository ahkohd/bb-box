# Each Namespace workspace is a backend that labels what it makes

Status: accepted
Date: 11 November 2026

## Context

BB Box allowed one Namespace backend. Namespace's Developer plan allows 12
Mac cores at once per workspace, which is 2 Mac boxes of 6 vCPU. A person
with more than one workspace could not add up their room ([#1455](https://github.com/ahkohd/bb-box/issues/1455)).

Docker and microsandbox already allow several backends of their type, one
per host ([042](042-a-docker-host-can-be-a-bb-machine.md)): each lists its guests on its
own host, so no two may share one. Namespace has no host. A workspace is
reached only through its token, and nothing in the configuration says which
workspace a token belongs to, so two backends may point at one workspace.

A Namespace backend found its machines by the install's label alone,
`bbbox-install`. Two backends of one install would each have held, swept,
extended and released the other's machines, destroyed the other's image
build machines, removed the other's stale tailnet devices, and built images
under the same tag and unique tag.

## Decision

- Namespace allows several backends, as `namespace`, `namespace:team-b`
  and so on. Its driver's `several` names no host, so two may share a
  workspace and a token.
- Each machine a Namespace backend makes, for a box, a shared iOS host, a
  measurement or an image build, carries `bbbox-backend`, the backend's ID
  with `-` for `:`, beside `bbbox-install`. A backend lists, finds, keeps
  alive, releases, sweeps and checks only machines with its own label.
- The backend with the ID `namespace` also owns machines with the
  install's label and no backend label, which earlier versions made. No
  other backend does. An install with one Namespace backend so keeps its ID,
  boxes, machines, iOS host and images, with no migration step. The first
  backend's names stay as they were: its unique tags, tailnet names and
  image tags.
- Most machines counts the backend's own machines and other installs'
  machines in the workspace, as before, but not another backend's of the
  same install, which counts against that backend's own Most machines. The
  workspace's Mac cores in use, which Namespace reports for the whole
  workspace, still count for each backend on it.
- Each backend builds its own Linux images in its workspace's registry.
  Another backend's image tags start with its name, so two backends on one
  workspace never push to the same tag. Its unique tags carry its ID too.
  No backend deletes registry images.
- Each backend keeps its shared iOS host's record in its own storage, with
  its ID, and the host's machine carries its label. Slots, hand-over, the
  last hour and cleanup go through that backend and its token.
- Another backend's machines join the tailnet as `bb-box-nsb-`, the
  install's ID, the length of the backend's name, the name, then the box's
  name, each followed by `-`, such as `bb-box-nsb-<install>-6-team-b-`.
  The length says where the name ends, so no backend's prefix starts
  another's tailnet name, and the first backend's, `bb-box-ns-`, starts
  none of theirs. Each backend so removes only its own stale devices. A
  short hash of the ID could not promise that: `namespace:team-339` and
  `namespace:team-3245` share the first 6 hex digits of their SHA-256.
- A Namespace backend's name is at most 15 characters, so its prefix fits
  in a tailnet name of 63 characters even with the longest install ID, 32
  characters. A longer prefix would be cut short, and 2 backends could
  then share a tailnet name. A driver sets this limit with `longestName`,
  and the configuration refuses a longer name.
- A shared iOS host's record, and a device host read from storage, that
  has no backend was written before this change and is the backend
  `namespace`'s. Reading it never makes it another backend's.
- A provider with no host, whose backend ID has a name, is called by its
  driver's label and that name in brackets, such as Namespace (team-b).
  `on` tries a name whole before it drops what follows in brackets, one
  bracket at a time.
- `bb box images list` lists the images a backend builds by itself,
  through `Backend.ownImages`, after the standard images. Its `--json`
  stays the standard images alone.

## Consequences

- The first Linux box of each kind on each Namespace backend waits for its
  own image build, about 4 to 9 minutes, even where another backend shares
  its workspace.
- boat.dev follows the same pattern, in
  [093](093-each-boat-dev-account-is-a-backend-that-labels-what-it-makes.md).
- A backend removed while its machines still run leaves them to their
  deadline, at most an hour away, as before. A machine without a backend
  label is no one's once the backend with the ID `namespace` is gone.
