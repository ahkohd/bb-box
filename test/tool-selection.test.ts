import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { manifestSkills, pluginRootAmong, selectTools } from "../src/plugin/tool-selection.ts";
import { tempDir } from "./helpers.ts";

function plugin(manifest: string | null, skills: Readonly<Record<string, string>> = {}): string {
  const root = tempDir("tool-selection");
  if (manifest !== null) writeFileSync(join(root, "package.json"), manifest);
  for (const [folder, text] of Object.entries(skills)) {
    mkdirSync(join(root, "skills", folder), { recursive: true });
    writeFileSync(join(root, "skills", folder, "SKILL.md"), text);
  }
  return root;
}

const MANIFEST = JSON.stringify({ bb: { skills: ["skills"] } });

test("071 unit 8, round 3, Astra 3: a skill whose SKILL.md has CRLF line endings is read by its name", () => {
  const root = plugin(MANIFEST, { crlf: "---\r\nname: crlf-skill\r\ndescription: one\r\n---\r\nBody\r\n", lf: "---\nname: lf-skill\ndescription: two\n---\n" });
  assert.deepEqual(manifestSkills(root)?.sort(), ["crlf-skill", "lf-skill"]);
});

test("071 unit 8, round 3, Astra 2: a manifest or skills folder bb-box cannot read gives no skills, never an error", () => {
  assert.equal(manifestSkills(plugin("{ not json")), null, "a manifest that is not JSON");
  assert.equal(manifestSkills(plugin(null)), null, "no manifest");
  assert.equal(manifestSkills(plugin(JSON.stringify({ bb: { skills: ["missing"] } }))), null, "a skills folder that is not there");
  const unreadable = plugin(null);
  mkdirSync(join(unreadable, "package.json"));
  assert.equal(manifestSkills(unreadable), null, "a manifest that cannot be read");
  assert.equal(manifestSkills(plugin(JSON.stringify({ bb: { skills: [7] } }))), null, "a skills root that is not a path");
  const good = plugin(MANIFEST, { lf: "---\nname: lf-skill\n---\n" });
  assert.equal(pluginRootAmong([unreadable, plugin("{ not json"), good]), good, "a candidate whose manifest cannot be read is passed over");
  assert.equal(pluginRootAmong([unreadable]), null);
});

test("071 unit 8, round 3, Astra 2: the tool selection never stops the plugin: with no skills it leaves BB's own selection in place, and a selection BB refuses is logged", () => {
  const errors: string[] = [];
  const logError = (operation: string, error: unknown) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
  let configured = 0;
  const quiet = { agents: { configure: () => void configured++ } } as unknown as BbPluginApi;
  selectTools(quiet, () => false, logError, null);
  assert.equal(configured, 0);
  assert.match(errors.join("\n"), /could not read its skills' names, so it leaves BB's own tool selection in place/);
  const refusing = {
    agents: {
      configure: () => {
        throw new Error("a second configure");
      },
    },
  } as unknown as BbPluginApi;
  assert.doesNotThrow(() => selectTools(refusing, () => false, logError, ["bb-box"]));
  assert.match(errors.join("\n"), /tool selection: a second configure/);
});
