# 034: A box a thread is working on is released or stopped only when forced

Status: accepted, 1 October 2026. Partly supersedes
[033](033-a-thread-can-start-on-a-new-box.md): only a thread that is
working stops a release or a stop, and a person can force one.

## Context

Since #111 a child thread can run on a box, and with "New box"
([033](033-a-thread-can-start-on-a-new-box.md)) a thread runs on a box of
its own. Releasing or stopping the box ends that thread's work. 033 had
`box_release` and `box_stop` refuse while any live thread ran on the box's
machine. But a thread that has finished stays live until it is archived,
so it would keep its box from being released for no reason.

## Decision

- A thread is working on a box when it runs on the box's BB machine, is
  neither archived nor deleted, and is busy (`active`, `starting`,
  `pending` or `stopping`) or waiting on a question to the user.
- `box_release`, `box_stop` and `bb box release` refuse while a thread is
  working on the box, and name the thread. The agent is told to leave the
  box, or to ask the user.
- A person can force it. The panel asks "Release <box> anyway?" or "Stop
  <box> anyway?", naming the threads, and acts only on that answer.
  `bb box release --force` and the RPC's `force` act at once.
- An idle thread does not stop a release or a stop. The answer names it
  as having lost its machine, and suggests archiving it.
- bb-box finds the threads with `threads.list({ hostId, archived: false })`.
  A box that is not a BB machine has none.

## Consequences

- An agent cannot end another thread's work by mistake. A person can,
  after one question.
- An idle thread whose box was released has no machine. It stays in BB
  until someone archives it.
- The sweep ([019](019-lost-records-are-restored-from-guests.md)) still
  releases a box whose thread was archived or deleted, without asking.
