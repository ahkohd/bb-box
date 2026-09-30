# 014: Boxes enrol through BB's machine provider API, when claimed

Status: accepted, 30 September 2026.

## Context

A box whose kind can enrol becomes a BB machine, so the thread's Git
credentials and machine variables reach it and child threads can run there
([002](002-bb-is-the-coordinator.md)). BB 0.44.0 offers plugins a machine
provider API: BB creates the host record, issues a one-time credential and
runs its own installer through an executor the plugin supplies.

The [enrolment research](../research/enrolment-and-warm-pools.md) found:

- nothing thread-specific is fixed at enrolment, because BB resolves the
  machine environment each time it is used;
- pre-installing bb-app in a template saves about 2 s;
- in a container with systemd, the installer's service dies with the SSH
  session unless the box user has linger;
- BB has no way to hide a machine from its machine list.

## Decision

- bb-box registers a machine provider. It enrols a box by creating a machine
  with the box ID as the key. The provider's `create` calls BB's `bootstrap`
  with an executor on the box's command transport.
- Templates and images carry Node.js, npm, curl and a pre-installed bb-app
  with its digest file. Where systemd runs, the box user has linger: a
  template sets it, and an SSH pool machine turns it on at claim, since its
  reset turns it off.
- A box enrols when it is claimed. Warm boxes are not enrolled ahead.
- Releasing a box removes its machine from BB before the backend releases the
  guest.

## Consequences

- bb-box never handles a long-lived BB credential. The one-time credential
  passes through the transport and is not stored or logged.
- A box runs commands before it is enrolled. Only BB's features wait for
  enrolment.
- Warm boxes stay out of BB's machine list, so no one starts a thread on an
  unclaimed box.
- If the timing experiment shows enrolment takes more than 3 s, pre-enrolling
  warm boxes and renaming them on claim is the next step, and gets its own
  record.
