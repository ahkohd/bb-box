# 032: Spare boxes are enrolled ahead, and BB shows them until claimed

Status: accepted, 1 October 2026. Partly supersedes
[014](014-enrol-through-machine-providers.md): warm boxes are not enrolled
ahead.

## Context

A box that enrols takes about 5 s after it is ready to become a BB machine
on Linux, and 8 to 11 s on a Mac
([BB request 5](../bb-requests.md#5-enrol-quickly-when-bb-app-is-installed)).
Until then it has none of the thread's GitHub access or variables. 014
named enrolling ahead as the next step if enrolment took more than 3 s.

014 enrolled no warm box, because BB cannot hide a machine. In BB's source
of 30 September 2026, it still cannot:

- a machine has no hidden flag, and `hosts.update` changes only its name;
- BB hides only ephemeral machines. It makes one when it places a thread
  on an ephemeral provider, and removes it once no thread uses it. A
  plugin cannot make one.

But every box is already an ordinary machine in BB's machine list and
picker, so a few more, named as spares, cost little. BB gives a machine's
daemon the same variables whichever thread uses it, so a machine enrolled
ahead has all a new one would. BB's installer still starts two daemons and
polls every 1 s, so request 5 is not close.

## Decision

- A spare is a ready, enrolled box that no thread owns. Core keeps a
  number of spares for each kind, set in the kind's settings
  ([029](029-configuration-is-one-checked-document.md)). The default is 0.
- An acquire of that kind at its default size claims a spare:
  1. It records the thread and project.
  2. It renames the machine from "<name> (spare)" to "<name>" with
     `hosts.update`.
  3. It returns at once.

  Core then makes a new spare in the background. When no spare suits, the
  acquire makes a box as before.
- A spare goes through the same paths as a box: enrolment, access setup,
  reconnect, the sweep and release. Backends do not change.
- The sweep keeps spares, although no thread owns them. Agents' `box_list`
  leaves them out. The panel shows them under their kind.
- At claim, a spare whose machine is not connected reconnects, as after
  `box_start`. A claim skips a spare that has a thread on its machine
  (`threads.list` with its host ID).
- A claim changes bb-box's record, not the guest's owner label
  ([018](018-guests-name-their-install-and-box.md)).

## Consequences

- An acquire that claims a spare should return in under 1 s, with the
  thread's GitHub access ready. This is to be measured.
- Spares show in BB's machine list and picker. If someone starts a thread
  on one, claims skip it. A hidden flag from BB would end this
  ([BB requests, "Possible later"](../bb-requests.md#possible-later)).
- A spare is a running box. It holds memory, and on Tart one of the Mac's
  two VM slots, while a warm VM there is suspended and holds none. So the
  default is 0, and the operator turns spares on for the kinds they use.
- If a claimed spare's record is lost, the sweep restores it as a spare
  ([019](019-lost-records-are-restored-from-guests.md)), not as its
  thread's box.
