# 033: A thread can start on a new box, from BB's new-thread screen

Status: accepted, 1 October 2026. Partly superseded by
[034](034-a-working-thread-holds-its-box.md): only a thread that is
working stops a release or a stop, and a person can force one.

## Context

An agent, or the panel, can start a child thread on a box its thread holds
(#111). #55 also asks for the other way round: you start a thread on a new
box from BB's new-thread screen.

In BB's source of 30 September 2026, BB's own Modal sandbox plugin does
this with SDK calls bb-box already has:

- a machine provider marked `ephemeral`, whose inputs come from a control
  the plugin supplies (`experimental_machineProviderInputs`);
- a composition (`experimental_environments.register` with a
  `machineProviderId` and an `environmentProviderId`) that pairs it with
  BB's project checkout. BB lists it in the new-thread screen.

For a thread placed this way, BB:

- calls the provider's `create` with the thread's ID as the key;
- makes the machine ephemeral, so it is not in BB's machine list or picker;
- clones the project onto it;
- removes it through the provider's `remove` once no live thread uses it,
  which is when the thread is archived or deleted.

## Decision

- bb-box registers a second machine provider, marked `ephemeral`. Its
  inputs are a kind and a size, chosen with the panel's kind picker. The
  first provider, which takes a box ID, stays as it is.
- It registers a composition, "New box", with BB's project checkout.
- `create`:
  1. reads the thread with `threads.get(key)`, and fails with a message if
     the key is not a thread;
  2. acquires a box of that kind for that thread and its project, with
     role "machine";
  3. bootstraps it with the key, and reports each step;
  4. returns the box's name and `{ boxId }`.
- `validate` refuses kinds that cannot enrol.
- `remove` releases the box. bb-box's sweep also releases it when the
  thread ends ([019](019-lost-records-are-restored-from-guests.md)).
  Whichever comes first does it.
- A role "machine" box is outside the per-thread limit. The panel and
  `box_list` label it as the thread's machine.
- `box_release` and `box_stop` refuse while a live thread runs on a box's
  machine, and say which thread. This covers #111's child threads too.

## Consequences

- A thread on a new box starts after the backend's warm guest, enrolment
  (about 5 s on Linux) and the clone: about 10 s on Linux, to be
  measured. Spares ([032](032-spare-boxes-are-enrolled-ahead.md)) do not
  help, as BB makes a new machine for the thread, and a spare is already
  another one.
- "New box" offers no Windows kinds, and none with enrolment off. It serves
  projects with a Git remote, which BB's project checkout needs.
- BB lists "New box" at the end of the new-thread picker's scrolling
  Machines list, below the fold once there are six machines, and lower with
  every box and spare that is a BB machine
  ([BB request 10](../bb-requests.md#10-show-machine-making-environments-where-they-can-be-seen)).
- BB passing the thread's ID as the key is its behaviour, not its
  documented API. If that changes, `create` fails with a message
  ([BB requests, "Possible later"](../bb-requests.md#possible-later)).
