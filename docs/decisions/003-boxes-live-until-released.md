# 003: Boxes live until their thread ends or they are released

Status: accepted, 30 September 2026.

## Context

Agents work asynchronously. A thread may sit idle for hours while you review
its work, then carry on. If a box expires or is reclaimed for idleness, the
agent loses its running apps, its build caches and your place in the desktop.

## Decision

- A box is released only when:
  - you or the agent release it;
  - its thread is archived or deleted.
- There is no maximum age and no idle timeout.
- The only limit is the provider's capacity. A limit on boxes per thread is a
  setting, off by default.
- Stopping and starting a box, where a backend supports it, is an action you or
  the agent take. It never happens automatically.

## Consequences

- Capacity is the real constraint. Backends report it before acquiring, and the
  message says what is full and what to release.
- The panel shows every box a thread holds, so forgotten boxes are visible.
- A crash must never lose track of a box. Ownership is recorded with the
  provider where possible (for example tags), and a sweep releases the boxes
  of ended threads ([architecture](../architecture.md#clean-up-and-crash-recovery)).
