const adjectives = ["quiet", "amber", "brisk", "calm", "bold", "clear", "dusty", "early", "fond", "keen", "lucky", "mild", "proud", "swift", "tidy", "warm", "young", "bright", "plain", "deep"];
const nouns = ["crane", "comet", "heron", "otter", "falcon", "maple", "river", "harbor", "lark", "finch", "cedar", "birch", "sparrow", "willow", "ridge", "pine", "kestrel", "dune", "meadow", "stone"];

export function sampleBoxName(taken: ReadonlySet<string>, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${adjectives[Math.floor(random() * adjectives.length)]}-${nouns[Math.floor(random() * nouns.length)]}`;
    if (!taken.has(name)) return name;
  }
  return `box-${taken.size + 1}`;
}
