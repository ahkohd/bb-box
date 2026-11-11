# A tailnet name too long is shortened with a code

Status: accepted
Date: 11 November 2026

## Context

A Namespace or boat.dev box joins the tailnet as a prefix, then the box's
name. The prefix holds the install's ID and, for a second backend of the
type, the length of the backend's name and the name
([087](087-each-namespace-workspace-is-a-backend-that-labels-what-it-makes.md),
[093](093-each-boat-dev-account-is-a-backend-that-labels-what-it-makes.md)).
A tailnet name is at most 63 characters, and a longer one was cut short.

An install's ID may be up to 32 characters, and a backend's name up to 13
for boat.dev and 15 for Namespace. With both at their longest, the prefix
alone was 63 characters, so every box of the backend had the same tailnet
name. Releasing one boat.dev box removed the tailnet devices of all of
them. The first backends, `boat` and `namespace`, had a smaller form of
this: with the longest install ID, 2 box names that differ only after
their 18th or 20th character, such as `nimble-sparrow-a1b2` and
`nimble-sparrow-a1b3`, shared a name.

Lowering the longest backend name enough to leave room for every box name
would refuse names people already use. A short hash of the backend's ID
cannot tell backends apart for certain: 087 found 2 names whose hashes
match.

## Decision

- A tailnet name that fits in 63 characters is as it was.
- A name that does not fit keeps the start of the box's name, then `-` and
  a code of 6 hexadecimal digits from the SHA-256 of the box's name. Two
  boxes of a backend so get names of their own.
- There is always room for at least 2 characters of the box's name and the
  code. Where the prefix leaves less, the install's ID in it becomes its
  first 16 characters, then `-` and a code of 6 hexadecimal digits from the
  SHA-256 of the ID. This happens only for a second backend on an install
  whose ID is longer than 23 characters. Each backend of the install that
  shortens the ID shortens it the same way, and the backend's length and
  name stay whole, so no backend's prefix starts another's tailnet name.
- A backend counts as its own a tailnet device whose name starts with its
  prefix, or with its prefix with the shortened install ID.
- The limits of 13 and 15 characters on a backend's name stay.

## Consequences

- No running box's tailnet name changes unless it was cut short before.
  A device of a box whose name was cut short, and which is still running
  through the update, is not removed by the box's release. The upkeep
  removes it once it has been gone for a while, as for any stale device.
- An install with a generated ID, 10 characters, never has a box's name
  shortened at all.
- The doctor counts a Namespace device with a shortened install ID as the
  install's.
- Two installs that share a tailnet could in principle share a shortened
  ID, but only if their first 16 characters and their codes both match.
