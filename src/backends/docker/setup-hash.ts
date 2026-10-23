import type { Hash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setupDir } from "../setup-dir.ts";

export function hashDockerSetup(hash: Hash, setup = setupDir()): Hash {
  const walk = (dir: string): string[] =>
    readdirSync(dir)
      .sort()
      .flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });
  for (const path of walk(join(setup, "docker"))) hash.update(relative(setup, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash;
}
