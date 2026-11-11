# A backend can be kept for BB projects

Status: accepted
Date: 11 November 2026

## Context

Every backend that is on served every thread. Some backends are held for one purpose: a Namespace workspace on an employer's plan, a GPU host bought for one project, a client's Proxmox server, or a Hetzner project billed to an employer. A person could not stop threads of other projects, or threads in no project, from using them ([#1458](https://github.com/ahkohd/bb-box/issues/1458)).

BB gives a plugin the project of each thread: the agent tools and the CLI get it with the call, and `threads.get` answers it for the panel and the CLI's `--thread`. A box already records its thread's project.

## Decision

- A backend has one more setting, `projects`: the IDs of the BB projects it is kept for. Left out or empty, it serves every project, so nothing changes for an install until a person sets a list.
- What a thread can use follows one rule in the core, `servesAudience`. A thread in a listed project may use the backend. A thread in another project, or in no project, may not. Spares and your own machines belong to no thread and may use every backend.
- Order: for a thread in a listed project, the backends kept for its project come first, in their settings order, then the shared ones. When the reserved ones are full, the box goes to a shared one. A thread claims a spare from its reserved backends first, and one from a shared backend only once the reserved backends have no room.
- Visibility: a thread outside the list never sees the backend. Its kinds are not in `box_list`, `bb box kinds` or the panel's New box form, `box_acquire` and `bb box acquire` never place a box there, and an `on` that names it is refused. The refusal says the backend is kept for certain projects, not which.
- Spares are made in settings order, as before. A spare on a reserved backend is claimed only by a thread of its projects. Warm boxes follow the placement, since a backend uses its warm guests only for boxes placed on it.
- A fork goes to its source's backend, so a fork into a thread outside that backend's projects is refused, by the check and by the fork. You may fork it as one of your machines, as a kept snapshot's fork always is.
- The doctor lists each reserved backend's projects by name, and warns when none of them is still in BB.
- The setting is chosen on a backend's settings page, from BB's projects by name, and with `bb box backend set <id> --projects`, by name or ID.
- A backend used only when named is not built. It relies on every agent knowing the name, and does not stop one that names it. Order and cost already cover backends to use only deliberately, and special hardware is a kind.

## Consequences

- A person can keep work's backends for work's threads, and those threads use them before personal backends.
- A backend whose projects are all deleted serves no thread. The doctor says so, and the person chooses its projects again or clears the list.
- Spares of a kind are counted across backends, as before. With a reserved backend first in the list, a kind's spares go there and serve only its projects, so a person who wants spares for every thread puts a shared backend first.
- `on` cannot reach a reserved backend from outside its projects, so a person who wants such a box makes it as one of their machines.
