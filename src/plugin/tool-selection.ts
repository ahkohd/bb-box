import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registeredTools } from "./purposes.ts";
import { acquireParameters } from "./tools.ts";
import { forkParameters } from "./snapshot-tools.ts";

type Parameters = Record<string, unknown>;

function pluginRoot(): string | null {
  for (const up of ["../../", "../"]) {
    const root = fileURLToPath(new URL(up, import.meta.url));
    const manifest = join(root, "package.json");
    if (existsSync(manifest) && (JSON.parse(readFileSync(manifest, "utf8")) as { bb?: { skills?: unknown } }).bb?.skills) return root;
  }
  return null;
}

export function manifestSkills(root: string | null = pluginRoot()): string[] | null {
  if (root === null) return null;
  const roots = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bb: { skills: readonly string[] } }).bb.skills;
  const names: string[] = [];
  for (const folder of roots) {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const skill = join(root, folder, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(skill)) continue;
      const front = /^---\n([\s\S]*?)\n---/.exec(readFileSync(skill, "utf8"))?.[1] ?? "";
      const name = /^name:\s*(\S+)\s*$/m.exec(front)?.[1];
      if (!name) return null;
      names.push(name);
    }
  }
  return names;
}

function parametersOf(schema: z.ZodType): Parameters {
  return z.toJSONSchema(schema) as Parameters;
}

export function withoutWholeCards(): ReadonlyMap<string, Parameters> {
  return new Map([
    ["box_acquire", parametersOf(acquireParameters(false))],
    ["box_fork", parametersOf(forkParameters(false))],
  ]);
}

export function selectTools(bb: BbPluginApi, wholeCards: () => boolean, logError: (operation: string, error: unknown) => void, skills: readonly string[] | null = manifestSkills()): void {
  if (skills === null) {
    logError("tool selection", new Error("bb-box could not read its skills' names, so it leaves BB's own tool selection in place, and box_acquire and box_fork advertise gpu whole while whole cards are off."));
    return;
  }
  const narrowed = withoutWholeCards();
  bb.agents.configure(() => {
    const overrides = wholeCards() ? new Map<string, Parameters>() : narrowed;
    return { tools: registeredTools(bb).map((name) => (overrides.has(name) ? { name, parameters: overrides.get(name)! } : name)), skills: [...skills] };
  });
}
