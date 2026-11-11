# A backend can be kept for BB projects

Status: accepted
Date: 11 November 2026

## Context

Every backend that is on served every thread. Some backends are held for one purpose: a Namespace workspace on an employer's plan, a GPU host bought for one project, a client's Proxmox server, or a Hetzner project billed to an employer. A person could not stop threads of other projects, or threads in no project, from using them ([#1458](https://github.com/ahkohd/bb-box/issues/1458)).

BB gives a plugin the project of each thread: the agent tools and the CLI get it with the call, and `threads.get` answers it for the panel and the CLI's `--thread`. A box already records its thread's project.

## Decision

- A backend has one more setting, `projects`: the IDs of the BB projects it is kept for. Left out or empty, it serves every project. With no list on any backend, nothing an install did before is refused, and boxes go where they went before. What changes is that more actions ask BB for the thread's project, which adds the time BB takes to answer, and a fork records the project its thread is in when it is made.
- What a thread can use follows one rule in the core, `servesAudience`. A thread in a listed project may use the backend. A thread in another project, or in no project, may not. Spares and your own machines belong to no thread and may use every backend.
- The thread's project is read from BB at the moment of each action, never from a record made earlier, such as the project a box was made in. `Boxes.audienceNow` asks BB, and treats a thread BB cannot place as one in no project. Every path that puts a thread's work on a backend goes through it, or through `Boxes.keptFromThread` or `Boxes.keptFrom`, which use it: acquiring, claiming a spare, a slot on a shared host, a fork, a restore that makes a new guest, a resize or GPU change that adds capacity, a child thread on a box, a New box that BB resumes making, a desktop built on demand, and the kinds the panel, `box_list` and `bb box kinds` list.
- A child thread on a box whose backend serves every project starts as before: in the project its box recorded, or the thread's when the box recorded none, so it starts even when BB cannot read the parent thread just then. On a backend kept for projects, the parent's project as BB says it now decides, and the child starts in that project. When BB cannot answer, the child is refused with that reason, and the person tries again.
- A New box whose making BB resumes is checked before BB is installed on it. A box BB had not finished making, on a backend that no longer serves the thread, is released and a new one acquired through the same check. A box that is already the thread's machine is not set up again, and keeps working.
- Order: for a thread in a listed project, the backends kept for its project come first, in their settings order, then the shared ones. When the reserved ones are full, the box goes to a shared one. A thread claims a spare from its reserved backends first, in their settings order whatever order the spares were made in, and one from a shared backend only once the reserved backends have no room. A slot on a shared iOS or macOS host comes from the reserved backends one at a time, in their settings order, then from the shared ones: the first reserved backend with room wins even when a later one, or a shared one, has a host ready and it must start one. Within one backend, and among the shared backends, the readiest host wins, as it did before for every backend.
- Visibility: a thread outside the list never sees the backend. Its kinds are not in `box_list`, `bb box kinds` or the panel's New box form, `box_acquire` and `bb box acquire` never place a box there, and an `on` that names it is refused. The refusal says the backend is kept for certain projects, not which.
- Spares are made in settings order, as before. A spare on a reserved backend is claimed only by a thread of its projects. Warm boxes follow the placement, since a backend uses its warm guests only for boxes placed on it.
- A fork goes to its source's backend, so a fork into a thread outside that backend's projects is refused, by the check and by the fork. You may fork it as one of your machines, as a kept snapshot's fork always is.
- The doctor lists each reserved backend's projects by name, and warns when none of them is still in BB. Run in a thread, it says only whether a backend serves that thread's project, without naming any project.
- A box already made stays with its thread when the thread moves to another project or the backend's projects change. It keeps running, and can stop, start, shrink, be snapshotted, be restored in place and be released. It cannot take more from the backend: a resize or GPU change that adds capacity, a restore that makes a new guest, a fork onto the backend and a child thread on the box are refused, as for a new box.
- The setting is chosen on a backend's settings page, from BB's projects by name, and with `bb box backend set <id> --projects`, by name or ID.
- A backend used only when named is not built. It relies on every agent knowing the name, and does not stop one that names it. Order and cost already cover backends to use only deliberately, and special hardware is a kind.

## Consequences

- A person can keep work's backends for work's threads, and those threads use them before personal backends.
- A backend whose projects are all deleted serves no thread. The doctor says so, and the person chooses its projects again or clears the list.
- Spares of a kind are counted across backends, as before. With a reserved backend first in the list, a kind's spares go there and serve only its projects, so a person who wants spares for every thread puts a shared backend first.
- `on` cannot reach a reserved backend from outside its projects, so a person who wants such a box makes it as one of their machines.
- Each acquire, fork, restore, resize and child thread asks BB for the thread's project once more. A thread whose project BB cannot read just then uses shared backends only, and cannot start a child thread on a box on a kept backend until BB answers.
- Moving a thread to another project does not take its boxes away. A person who wants that releases them.
