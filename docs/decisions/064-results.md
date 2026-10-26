# 064 results

What each build unit of [064](064-ios-shared-hosts.md) measured and
checked. Each unit has a section of its own.

## Unit 2: the data model, `dedicated` and `shared`

Built on 26 October 2026.

### What it adds

- **`src/core/device-host.ts`**: 064's types for hosts, slots, placements
  and tiers; a slot's user and UID from its generation; each slot's ports;
  validators for a host and a slot as a helper's status gives them, and for
  a placement in `guest.data`; the slot's capabilities; and the words of
  every refusal.
- **The placement on the box record,** read from `guest.data` by
  `placementOf`, written once by the backend at the claim. A box with no
  slot keys is a VM of its own. The claim writes the slot's capabilities
  over the offer's: no root, no host desktop, no desktop computer use; the
  device and enrolment stay.
- **`dedicated`** for ios and **`shared`** for ios and macos, on
  `box_acquire`, `bb box acquire` (`--dedicated`, `--shared`) and the
  panel's acquire.
- **Refusals,** each in words naming `dedicated`: once shared ios boxes
  are the default, a size for an ios box without `dedicated: true`;
  `shared: true`, as no shared iOS host is set up; and for a box in a slot, a stop, a start, a resize, a restart and a
  grant. `dedicated` on another kind, `shared` on a kind that has no slot,
  and both at once, are refused too.
- **The switch,** `SHARED_IOS_BY_DEFAULT` in `src/core/device-host.ts`,
  off. Unit 6 turns it on in the change that makes shared the default.
  While it is off, an ios size without `dedicated` is today's box, a VM of
  its own at that size, and box_list says nothing of a size. With it on, the
  size is refused and box_list says a size needs `dedicated: true`.
- **box_list** says, on the ios kind's line, that each box is a VM of its
  own, that `dedicated: true` asks for one, and that no shared iOS host is
  set up. **box_status** has a Where line: "A VM of its own.", or for a box
  in a slot "On a shared iOS host (a Tart VM), slot 3 of 8. Ports 20300 to
  20399, in BB_PORT_BASE and BB_PORT_COUNT.", with its Root line naming
  `dedicated` and no Size line.
- **The New box form,** for the ios kind, a Machine choice under System,
  before the device: Shared, shown off with "No shared iOS host is set
  up.", and A VM of its own, chosen. The size shows only with A VM of its
  own, and Create sends `dedicated: true`. Your machines, which are always
  VMs of their own, do not show the choice.
- **The skill** says when to ask for `dedicated`, and to give it with a
  size, which a size will need once shared is the default.

### Checks

| Check | How | Result |
| --- | --- | --- |
| The compile-time cases | `test/device-host-types.ts`: 13 legal shapes and 20 illegal ones, each marked `@ts-expect-error`. tsc run with every mark removed | tsc passes with the marks. Without them it fails on exactly the 20 lines, each for its own reason: a pool Mac starting or deleting, a Tart host lent whole or with an end, a Namespace host with no end, a carried third slot, a slot record holding its user and UID, a held ios slot with no device, a held macos slot with one, an Android model in a slot, a VM placement with a host |
| `dedicated: true` gives today's box | the registry against the fake backend | a ready box, a VM of its own, with the offer's capabilities and the size asked for, stop and start offered |
| A size without `dedicated`, the switch off | the same | today's box: a VM of its own at the size asked; box_list's line names no size rule |
| A size without `dedicated`, the switch on | the same, with the registry told shared is the default | refused: "A shared ios box has no size of its own. Ask for dedicated: true with a size." With a preset, with cores alone, and with `dedicated: false`; box_list says a size needs it |
| A box in a slot | the fake backend's guest given a slot's placement | the slot's capabilities stored; box_status's Where and Root lines; each refusal in its words |
| The validators | `test/device-host.test.ts` | each legal shape read back whole; each illegal one that reaches a reader refused in words naming its field |
| The form, by keyboard | vitest, the panel rendered with a stub server | Shared is `aria-disabled`, out of the tab order, says "No shared iOS host is set up."; a click or an arrow key leaves A VM of its own chosen; Create sends `acquire ios dedicated`, and with Large, `acquire ios {"preset":"large"} dedicated` |
| A separate BB | a fresh `npx bb-app` with no account in a Linux desktop box, bb-box installed from the branch's path, Docker set up | `bb box acquire linux --shared` and `--dedicated` refused in their words; `ios --dedicated` refused as no backend offers ios there |
| The suite | tsc, `npm test` (the node suite, then vitest) and the docs test, on a Linux box, on the branch rebased onto origin/main at 78c54b64 | tsc clean; the node suite 2,046 passed, 0 failed, 288 skipped; vitest 217 passed |

### What limits these checks

- **No shared host exists yet,** so no real box has been in a slot. A box
  in a slot was checked only with the fake backend, its guest given a
  slot's placement by the test.
- **The separate BB has no ios kind.** Only Tart offers ios, and a fresh
  BB has no Mac it may reach, so an ios box there could not be made, and
  its form shows no Machine choice. A fresh BB has no agent either, so the
  checks there went through `bb box`, which shares the registry and the
  words with the tools.
- **Not checked here,** and due after the deploy: `dedicated: true`
  through production BB's tools on a real ios box, with box_list and
  box_status read back; and the New box form's ios choice in the
  production panel at 360 px and by keyboard.

### Deviations from 064

- **The placement's keys in `guest.data` are `slotHost`, `slotHostOn`,
  `slotGeneration`, `slotCarried`, `slotPlace` and `slotMost`,** not
  `host`, `generation` and `carried`: the SSH host pool already keeps its
  own `generation` there, which a pool Mac's slot (unit 5) would meet.
- **A slot placement holds `hostOn`, `place` and `most` too,** so
  box_status can name the host's kind, the slot's number and its ports
  without asking the host.
- **Some acquires are VMs of their own without `dedicated`:** spares, your
  machines, a thread's own machine, a box from a build, and a box with a
  project's image. Their sizes are not refused.
- **box_list's ios line** says what is true until unit 4: each box is a VM
  of its own. 064's "Shared by default" words wait for unit 6.
