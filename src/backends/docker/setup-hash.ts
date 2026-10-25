import type { Hash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { setupDir } from "../setup-dir.ts";

export const IMAGE_BUILD_INPUTS = ["docker", "proxmox-lxc/host/common.sh", "proxmox-lxc/template"] as const;

function readByTheBuild(path: string): boolean {
  return !path.endsWith(".md");
}

export function imageBuildInputs(setup = setupDir()): string[] {
  const walk = (path: string): string[] => {
    if (!existsSync(path)) return [];
    if (!statSync(path).isDirectory()) return [path];
    return readdirSync(path)
      .sort()
      .flatMap((name) => walk(join(path, name)));
  };
  return IMAGE_BUILD_INPUTS.flatMap((input) => walk(join(setup, input))).filter(readByTheBuild);
}

export function hashDockerSetup(hash: Hash, setup = setupDir()): Hash {
  for (const path of imageBuildInputs(setup)) hash.update(relative(setup, path)).update("\0").update(readFileSync(path)).update("\0");
  return hash;
}
