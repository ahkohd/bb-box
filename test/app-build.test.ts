// The panels build as BB's frontend build builds them (#941): BB gives the
// app its own copies of the packages below, and resolves anything else from
// the plugin's dependencies, without its devDependencies. The server SDK,
// @get-bb/plugin-sdk, is one of those, so a value that src/app imports from a
// file that imports the server SDK failed BB's build, while CI's, with every
// package installed, passed. This test resolves as BB's build does, and names
// each import it cannot resolve and the chain of files that leads to it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The packages BB's app gives a plugin's app at load time, from BB 0.46.0's plugin build. */
export const BB_PROVIDES = new Set([
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "@get-bb/plugin-sdk/app",
  "@bb/plugin-sdk/app",
  "@pierre/diffs",
  "@pierre/diffs/react",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-select",
  "@radix-ui/react-tooltip",
  "sonner",
  "vaul",
  "clsx",
  "tailwind-merge",
  "class-variance-authority",
  "@bb/shared-ui/icon",
  "@bb/shared-ui/question-form-host",
  "@bb/shared-ui/voice-input-textarea",
]);

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** The imports of `entry` that BB's frontend build could not resolve, each with the files that lead to it. */
export async function unresolvable(entry: string, dependencies: ReadonlySet<string>): Promise<string[]> {
  const importers = new Map<string, string>();
  const problems: { importer: string; specifier: string }[] = [];
  const bundle = await rolldown({
    input: entry,
    logLevel: "silent",
    // BB's build follows the plugin's tsconfig paths, such as @/components.
    tsconfig: join(ROOT, "tsconfig.json"),
    plugins: [
      {
        name: "as-bb-builds",
        async resolveId(specifier, importer) {
          if (BB_PROVIDES.has(specifier)) return { id: specifier, external: true };
          // A package's own imports are its dependencies', which install with it.
          if (!importer || specifier.startsWith(".") || specifier.startsWith("/") || importer.includes("/node_modules/")) return null;
          const resolved = specifier.startsWith("node:") ? null : await this.resolve(specifier, importer, { skipSelf: true });
          const ownFile = !!resolved && !resolved.external && !resolved.id.includes("/node_modules/");
          if (ownFile || (resolved && dependencies.has(packageOf(specifier)))) return resolved;
          problems.push({ importer, specifier });
          return { id: specifier, external: true };
        },
        moduleParsed(info) {
          for (const imported of [...info.importedIds, ...info.dynamicallyImportedIds]) if (!importers.has(imported)) importers.set(imported, info.id);
        },
      },
    ],
  });
  try {
    await bundle.generate({ format: "esm" });
  } finally {
    await bundle.close();
  }
  return problems.map(({ importer, specifier }) => {
    const chain = [importer];
    for (let at = importer; importers.has(at) && chain.length < 20; ) {
      at = importers.get(at)!;
      chain.unshift(at);
    }
    return `${chain.map((file) => relative(ROOT, file)).join(" -> ")} imports "${specifier}"`;
  });
}

test("the panels build as BB's frontend build builds them: src/app imports no value that leads to a server-only module (#941)", async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bb: { app: string }; dependencies: Record<string, string> };
  const problems = await unresolvable(join(ROOT, pkg.bb.app), new Set(Object.keys(pkg.dependencies)));
  assert.deepEqual(
    problems,
    [],
    `BB's frontend build cannot resolve these, as BB gives a plugin's app only its own packages and the plugin's dependencies, not its devDependencies or Node's modules:\n${problems.join("\n")}\nImport only types from such a file (import type), or move the value the app needs into a file that imports nothing server-only.`,
  );
});

test("the check names an app's value import from a file that imports the server SDK, with the files that lead to it", async () => {
  const problems = await unresolvable(join(ROOT, "test", "fixtures", "app-imports", "entry.tsx"), new Set(["zod"]));
  assert.deepEqual(problems, ['test/fixtures/app-imports/entry.tsx -> test/fixtures/app-imports/contract.ts imports "@get-bb/plugin-sdk"']);
});
