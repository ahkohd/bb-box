// Kind IDs that were renamed (027). The default box has no qualifier, and
// only desktops say so: linux-headless became linux. The earlier IDs stay
// accepted wherever a kind ID comes in: box_acquire, stored records and the
// kind a guest names. What bb-box shows uses the current IDs.

const RENAMED: ReadonlyMap<string, string> = new Map([
  ["linux-headless", "linux"],
  ["linux-headless-docker", "linux-docker"],
]);

/** The current ID of a kind, given its current or an earlier ID. */
export function currentKindId(id: string): string {
  return RENAMED.get(id) ?? id;
}

/** True when `id` is an earlier ID of a kind that has a new one. */
export function isEarlierKindId(id: string): boolean {
  return RENAMED.has(id);
}
