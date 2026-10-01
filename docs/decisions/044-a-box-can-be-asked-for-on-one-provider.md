# 044: A box can be asked for on one provider

Status: accepted, 1 October 2026. Extends
[011](011-interface-v1.md): an acquire may name the one provider to try.

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

**Strict, with no fallback.**

- Only that provider's offer of the kind is tried. A spare is claimed only
  from it, and a spare is released to make room only on it.
- When it is full, offline or off, the acquire is refused with its words.
  The refusal names the kind's other providers and says that leaving `on`
  out takes the first with room.
- A person or agent who names a place wants that place. A box placed
  elsewhere would also pass a live check that should fail.

**`box_list` names the providers.** Each kind's line ends with its
providers in acquire order, in the words `on` takes: "On: Proxmox LXC on
pve1, Docker on devpc." An agent never guesses a name.

**The New box form.**

- When the detail pane shows the chosen kind and the kind has more than
  one offer, its offers are a choice. "First with room" comes first and is
  chosen at first, in place of the line "the first with room, in that
  order"; each offer follows. When the pane follows the pointer to another
  kind, its offers are plain text, as now.
- The tab order is kinds, then the provider choice when there is one, then
  Size, Name and Create.
- Choosing another kind sets the choice back to "First with room". The
  form does not remember it, as it remembers the kind and size. The
  configuration's order is the standing preference, so a person who always
  wants one machine first moves it up in settings.
- A refusal shows under the button, as other refusals do, and the popover
  stays open.
- Add machine ([036](036-your-machines-are-boxes-you-own.md)) is the same
  form, so it has the same choice.

**Not changed.**

- The Backend interface. Core keeps only the named provider's offer before
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
- A provider's name is now something an agent types. A BB machine renamed
  in BB renames its "Docker on" provider, and an `on` with the old name is
  refused, with the new name listed.
