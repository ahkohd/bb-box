# 044: A box can be asked for on one provider

Status: accepted, 1 October 2026. Extends
[011](011-interface-v1.md): an acquire may name the one provider to try.
Amended while it was built, 2 October 2026: the provider choice is a step
of the stepped New box form (#333), filtered by kind of provider and by
the machine it runs on; and `on` takes a list of providers, the first with
room among them taking the box, so a filtered "First with room" never
places a box outside the filter.

## Context

The registry tries a kind's offers in the configuration's order and takes
the first with room ([011](011-interface-v1.md),
[029](029-configuration-is-one-checked-document.md)). Neither a person nor
an agent can say where a box goes.

- A live check of a backend needs a box on that backend. Today the
  operator moves it first in the order for the check, which moves every
  other thread's new boxes there too.
- A person may want a box on one machine for the task in hand, such as
  their own PC with Docker
  ([042](042-a-docker-host-can-be-a-bb-machine.md)) or one Proxmox host.
- The New box pane already lists each offer of a kind in acquire order,
  with its provider and host: "Proxmox LXC on pve1", "Docker on devpc",
  "Tart on 2 Macs". `box_list` names the kinds but not their providers.

## Decision

**An acquire may name its provider.**

- `box_acquire` gains an optional `on`: "Where the box goes, from
  box_list: a provider such as Docker on devpc. Leave it out for the first
  with room." `bb box acquire` and `bb box machines add` take `--on`, and
  the panel's and settings' forms send it.
- `on` matches, without case, the provider's name as `box_list` and the
  pane give it, its backend ID, or the name of its host when it has one
  host. So "Docker on devpc", `docker:devpc` and "devpc" name the same
  provider.
- A name that matches no provider is refused, and the refusal lists the
  kind's providers. A name that matches two is refused with their IDs. A
  provider without the kind is refused with the kinds it has.

**`on` may be a list** (amended while it was built).

- `on` takes one provider or a list of them, each in the words above.
  `box_acquire`'s `on` is a string or a list of strings: "Where the box
  goes, from box_list: a provider such as Docker on devpc, or a list of
  them for the first with room among them. Leave it out for the first with
  room." `--on` takes names separated by commas (`--on pve1,devpc`). The
  forms send backend IDs.
- The first with room among them takes the box, in acquire order. The list
  narrows the choice and does not reorder it: the configuration's order
  stays the one preference, and the form's rows, in that order, read true.
- Each name is checked as one is above, and any refusal there refuses the
  acquire: a list with a mistake in it is a mistake, and placing the box on
  the rest would hide it. A name given twice counts once. An empty list is
  refused.
- A list of one is the same as that name.

**Strict, with no fallback.**

- Only the named providers' offers of the kind are tried. A spare is
  claimed only from them, and a spare is released to make room only on
  them.
- When none has room, the acquire is refused, with each named provider's
  reason in its own words: full, offline or off. The refusal names the
  kind's other providers and says that leaving `on` out takes the first
  with room.
- A person or agent who names a place wants that place. A box placed
  elsewhere would also pass a live check that should fail.

**`box_list` names the providers.** Each kind's line ends with its
providers in acquire order, in the words `on` takes: "On: Proxmox LXC on
pve1, Docker on devpc." An agent never guesses a name.

**The New box form** (amended while it was built: the stepped form of
#333; docs/design/panel.md has the detail).

- The provider choice is the form's Provider step, after System,
  Architecture and Type, and before Resources. Two filters narrow its
  rows: Kind chips (All, Container, VM, Physical) and Runs on (Any
  machine, a Mac, a Linux machine, a Windows PC). A provider that does not
  know yet what its machine runs stays under every Runs on choice.
- "First with room" comes first and is chosen at first; one row per
  provider follows, in acquire order.
- What the form sends:
  - a chosen row sends its backend ID as `on`;
  - "First with room" with every provider of the kind shown sends no
    `on`;
  - "First with room" with the filters hiding some sends the shown rows'
    backend IDs as a list, so the box never lands on a provider the
    filters hid; a filter that leaves one sends that one.
- One offer is no choice: its row stands alone, checked, and no `on` goes.
- Another type, or closing the form, sets the choice and the filters back.
  The form does not remember them, as it remembers the kind and size. The
  configuration's order is the standing preference, so a person who always
  wants one machine first moves it up in settings.
- A refusal shows under the form's summary bar, as other refusals do, and
  the popover stays open.
- Add machine ([036](036-your-machines-are-boxes-you-own.md)) is the same
  form, so it has the same choice.

**The Backend interface** gains one optional field (amended while it was
built): `hostOs`, what the machine its boxes run on runs (`linux`, `macos`
or `windows`), or null until it knows, for the Runs on filter. Proxmox
and pool machines are Linux and Tart's are Macs. A Docker backend reports
what its machine says:

- for a BB machine, the platform bb-box's host entry there reports over
  the relay;
- for a local daemon, the platform of BB's server;
- for an `ssh://` daemon, what `docker info` says, kept in the backend's
  storage as its host's name is.

**Not changed.**

- How core places a box. It keeps only the named providers' offers before
  it asks for capacity, and the box record keeps its backend, as now.
- "New box" in BB's new-thread screen
  ([033](033-a-thread-can-start-on-a-new-box.md)) takes the first with
  room. Its form is BB's; `on` can join its inputs later.
- Spares are made on the first offer with room.

## Consequences

- A live check of a backend acquires with `on`, and the configuration
  stays as it is.
- An acquire with `on` can be refused where one without it would get a
  box. The refusal says how to get one anyway.
- A person who filters the form and leaves "First with room" gets a box on
  one of the providers they see, or a refusal that says why each is full.
  An agent can ask for "any of these" in the same way.
- A provider's name is now something an agent types. A BB machine renamed
  in BB renames its "Docker on" provider, and an `on` with the old name is
  refused, with the new name listed.
