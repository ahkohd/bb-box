import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { registeredTools } from "./purposes.ts";
import { acquireParameters } from "./tools.ts";
import { forkParameters } from "./snapshot-tools.ts";

type Parameters = Record<string, unknown>;

interface Manifest {
  readonly bb?: { readonly skills?: unknown };
}

function manifestOf(root: string): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

export function pluginRootAmong(candidates: readonly string[]): string | null {
  return candidates.find((root) => manifestOf(root)?.bb?.skills !== undefined) ?? null;
}

function pluginRoot(): string | null {
  return pluginRootAmong(["../../", "../"].map((up) => fileURLToPath(new URL(up, import.meta.url))));
}

function skillsUnder(root: string): string[] | null {
  const roots = manifestOf(root)?.bb?.skills;
  if (!Array.isArray(roots) || !roots.every((folder): folder is string => typeof folder === "string")) return null;
  const names: string[] = [];
  for (const folder of roots) {
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const skill = join(root, folder, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(skill)) continue;
      const text = readFileSync(skill, "utf8").replace(/\r\n?/g, "\n");
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      const name = /^name:\s*(\S+)\s*$/m.exec(front)?.[1];
      if (!name) return null;
      names.push(name);
    }
  }
  return names;
}

export function manifestSkills(given?: string | null): string[] | null {
  try {
    const root = given === undefined ? pluginRoot() : given;
    return root === null ? null : skillsUnder(root);
  } catch {
    return null;
  }
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
  try {
    const narrowed = withoutWholeCards();
    bb.agents.configure(() => {
      const overrides = wholeCards() ? new Map<string, Parameters>() : narrowed;
      return { tools: registeredTools(bb).map((name) => (overrides.has(name) ? { name, parameters: overrides.get(name)! } : name)), skills: [...skills] };
    });
  } catch (error) {
    logError("tool selection", error);
  }
}
