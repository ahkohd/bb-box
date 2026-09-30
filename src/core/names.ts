// Friendly Docker-style names for boxes: one curated adjective and one curated
// noun, such as quiet-heron. A backend may use it as the hostname or the
// guest's name. It is display metadata only: the box ID and the backend's guest
// reference identify a box, so nothing is released or deleted by name. The lists are short and reviewed: no product, provider,
// purpose or operating-system words, nothing offensive or ambiguous.

export const ADJECTIVES = [
  "amber", "bold", "brave", "bright", "calm", "clear", "clever", "cool",
  "crisp", "eager", "early", "fair", "fond", "fresh", "gentle", "glad",
  "golden", "green", "happy", "hardy", "honest", "jolly", "keen", "kind",
  "light", "lively", "lucky", "merry", "mild", "modest", "neat", "nimble",
  "noble", "plain", "polite", "proud", "quick", "quiet", "rapid", "ready",
  "rosy", "round", "silver", "smart", "sturdy", "sunny", "swift", "tidy",
  "vivid", "warm", "wise", "witty", "young", "zesty",
] as const;

export const NOUNS = [
  "acorn", "badger", "beacon", "birch", "brook", "canyon", "cedar", "cliff",
  "cloud", "comet", "coral", "crane", "delta", "dune", "eagle", "ember",
  "falcon", "fern", "finch", "fjord", "forest", "glade", "harbor", "heron",
  "hill", "island", "jade", "lagoon", "lark", "lantern", "linden", "maple",
  "marsh", "meadow", "moss", "oriole", "otter", "pebble", "petrel", "pine",
  "plover", "prairie", "quail", "reef", "ridge", "river", "robin", "sparrow",
  "spruce", "summit", "tundra", "valley", "willow", "wren",
] as const;

/**
 * adjective-noun, with an optional short hexadecimal suffix added only when
 * the pair collides. At most 24 characters, so it is a valid BB machine name,
 * hostname label and guest name.
 */
export const namePattern = /^[a-z]{3,8}-[a-z]{3,8}(?:-[a-f0-9]{2,4})?$/;
export const MAX_NAME_LENGTH = 24;

export function isFriendlyName(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_NAME_LENGTH && namePattern.test(value);
}

/**
 * Picks a name that is not in `taken`. `random(n)` must return n bytes from a
 * cryptographic generator; the bytes select words and, on collision, the
 * suffix. The suffix is not secret and reveals nothing about any credential.
 */
export function generateName(taken: ReadonlySet<string>, random: (bytes: number) => Uint8Array): string {
  const pick = <T>(list: readonly T[]): T => {
    const [a = 0, b = 0] = random(2);
    return list[((a << 8) | b) % list.length]!;
  };
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
    if (!taken.has(base)) return base;
  }
  // The pair space is nearly exhausted for this thread: keep a memorable base
  // and add a short non-secret suffix until it is unique.
  const base = `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
  for (let attempt = 0; attempt < 64; attempt++) {
    const suffix = Buffer.from(random(attempt < 32 ? 1 : 2)).toString("hex");
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("Could not choose a unique name.");
}
