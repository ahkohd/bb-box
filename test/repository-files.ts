import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "scripts/preview/out"]);

function gitWorkTreeFiles(root: string): string[] | null {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return null;
  const listed = git("ls-files", "-z");
  return listed.status === 0 ? listed.stdout.split("\0").filter(Boolean) : null;
}

function walkedFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name) || IGNORED_DIRECTORIES.has(path)) continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  walk("");
  return found;
}

export function repositoryFiles(root: string, wanted: (path: string) => boolean): string[] {
  return (gitWorkTreeFiles(root) ?? walkedFiles(root)).filter(wanted).sort();
}
