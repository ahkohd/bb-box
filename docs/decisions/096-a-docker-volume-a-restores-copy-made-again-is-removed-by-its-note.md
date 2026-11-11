# A Docker volume a restore's copy made again is removed by its note

Status: accepted
Date: 11 November 2026

Supersedes the release rule in
[082](082-docker-snapshots.md#what-lives-on-the-engine) that a release
removes only volumes labelled for its container, for a volume a restore's
copy made again.

## Context

A Docker restore copies the snapshot's Docker data into the new
container's volume with a copy container. If BB stops part way, Docker can
still make that copy after a release has removed the volume. Docker then
makes the volume again, without labels. Under 082's rule, nothing removes
it, as it has no labels.

BB Box notes each copy in its own storage before it asks Docker for it. A
release and maintenance read the note. The first version of the fix had
two faults:

- every release asked Docker for copies into its volume, and read the
  volume's labels twice, though almost no release follows a killed restore
- maintenance removed a copy, then dropped its note. If removing the
  volume then failed, nothing named the volume again

## Decision

1. A release reads BB Box's own storage first. With no note of a copy into
   the volume, it removes the volume as before this record: one list, one
   inspect and one removal, with no wait. Only if Docker says the volume
   is in use does it look for a copy into it, remove that and try again,
   up to 5 times a second apart.
2. With a note, a release removes every copy into the volume, then the
   volume, and waits for a copy Docker may still be making, as 082's
   results describe.
3. BB Box removes a volume without labels only when a note or a copy's
   labels name it, and only for its own install. A volume with labels must
   still be labelled for the container and the install.
4. Maintenance writes a note for each copy it finds before it removes the
   copy, if there is none. It drops a note only once the volume has gone,
   or has labels and so belongs to a box. A failed removal keeps the note
   and counts it. Maintenance tries each note once a sweep, and goes on to
   the next if one fails.
5. After 3 failed removals the doctor's Snapshot leftovers check warns,
   names the volume and says how to find what holds it.

## Consequences

- An ordinary release makes no more Docker calls than it did before
  restores had copy containers.
- A volume made again stays named in BB Box's storage until it is removed,
  however many sweeps that takes.
- A lost storage still leaves the copy's labels, which maintenance reads
  and turns into a note.
- The rule rests on the notes and labels being right. The copy's name
  holds the new container's name, which holds the box's ID and a random
  suffix, so it cannot name another box's volume.
