// The docs against the code (#503): the reference is as scripts/reference.ts
// would write it and names everything the code has, links between Markdown
// files lead somewhere, and the skill tells the agent of every tool.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { REFERENCE_DIR, anchor, referencePages, registered } from "../scripts/reference.ts";
import { DRIVERS } from "../src/backends/index.ts";
import { KIND_INFO } from "../src/backends/kinds.ts";
import { CHECKS } from "../src/core/checks.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = (file: string) => readFileSync(join(REFERENCE_DIR, file), "utf8");

/** The headings of a page at a level, as their text. */
const headings = (text: string, level: number) => [...withoutCode(text).matchAll(new RegExp(`^${"#".repeat(level)} (.+)$`, "gm"))].map((match) => match[1]!.trim());

/** A page's text with its fenced code blocks blanked out, so lines keep their numbers. */
function withoutCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, ""));
}

/** The first cell of each table row in a part of a page: `key` from "| `key` | ...". */
const keys = (text: string) => new Set([...text.matchAll(/^\| `([^`]+)` \|/gm)].map((match) => match[1]!));

/** The part of a page under a heading, up to the next heading at that level or above. */
function section(text: string, heading: string): string {
  const level = heading.match(/^#+/)![0].length;
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `no heading ${heading}`);
  const end = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

test("the reference in docs/reference is as npm run reference writes it", async () => {
  const stale = Object.entries(await referencePages())
    .filter(([file, text]) => !existsSync(join(REFERENCE_DIR, file)) || page(file) !== text)
    .map(([file]) => `docs/reference/${file}`);
  assert.deepEqual(stale, [], "out of date: run npm run reference");
});

test("the reference names every command, tool and parameter, field, kind and check", async () => {
  const found = await registered();

  const cli = headings(page("cli.md"), 2);
  for (const command of found.cli.commands) assert.ok(cli.includes(command.usage.split(/ [<[]/)[0]!), `cli.md has no section for ${command.usage}`);

  const tools = page("tools.md");
  for (const tool of found.tools) {
    assert.ok(headings(tools, 2).includes(tool.name), `tools.md has no section for ${tool.name}`);
    const parameters = keys(section(tools, `## ${tool.name}`));
    for (const key of Object.keys(tool.inputSchema.properties ?? {})) assert.ok(parameters.has(key), `tools.md has no row for ${tool.name}'s ${key}`);
  }

  const configuration = page("configuration.md");
  for (const driver of DRIVERS) {
    const fields = keys(section(configuration, `### ${driver.type}`));
    for (const key of [...Object.keys(driver.fields), ...Object.keys(driver.hostFields ?? {})]) assert.ok(fields.has(key), `configuration.md has no row for ${driver.type}'s ${key}`);
  }

  const kinds = keys(page("kinds.md"));
  for (const kind of Object.keys(KIND_INFO)) assert.ok(kinds.has(kind), `kinds.md has no row for ${kind}`);

  const checks = keys(page("checks.md"));
  for (const id of Object.keys(CHECKS)) assert.ok(checks.has(id), `checks.md has no row for ${id}`);
});

/** The anchors a page's headings make, as GitHub makes them, with -1, -2 for a heading again. */
function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const found = new Set<string>();
  for (const match of withoutCode(text).matchAll(/^#{1,6} (.+?)#*$/gm)) {
    const base = anchor(match[1]!.trim().replace(/`/g, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    found.add(count ? `${base}-${count}` : base);
  }
  return found;
}

test("every link from one Markdown file to another leads to a file, and to a heading in it", () => {
  const files = execFileSync("git", ["ls-files", "*.md"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.ok(files.length > 10, "git lists the Markdown files");
  const broken: string[] = [];
  for (const file of files) {
    const text = withoutCode(readFileSync(join(root, file), "utf8")).replace(/`[^`\n]*`/g, "");
    for (const match of text.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const target = match[1]!;
      if (/^[a-z][a-z+.-]*:/i.test(target)) continue;
      const [path, fragment] = target.split("#") as [string, string | undefined];
      const to = path ? join(dirname(join(root, file)), decodeURIComponent(path)) : join(root, file);
      if (!existsSync(to)) {
        broken.push(`${file}: ${target} (no ${relative(root, to)})`);
        continue;
      }
      if (fragment && to.endsWith(".md") && statSync(to).isFile() && !anchors(readFileSync(to, "utf8")).has(fragment.toLowerCase())) broken.push(`${file}: ${target} (no heading #${fragment})`);
    }
  }
  assert.deepEqual(broken, []);
});

test("the skill names every tool the agent gets", async () => {
  const skill = readFileSync(join(root, "skills", "bb-box", "SKILL.md"), "utf8");
  const missing = (await registered()).tools.map((tool) => tool.name).filter((name) => !new RegExp(`\\b${name}\\b`).test(skill));
  assert.deepEqual(missing, [], "skills/bb-box/SKILL.md does not mention these tools");
});

test("the iOS guide gives the shared host's slot log folder, its last slot and UID, and that a failed lend removes the slot, as device-host.sh has them", () => {
  const guide = readFileSync(join(root, "setup", "tart", "ios", "README.md"), "utf8").replace(/\s+/g, " ");
  const helper = readFileSync(join(root, "setup", "tart", "ios", "device-host.sh"), "utf8");
  const setting = (name: string) => new RegExp(`^${name}=(.+)$`, "m").exec(helper)?.[1];
  const logs = setting("SLOT_LOGS")!.replace("$ROOT", "");
  const lastSlot = Number(setting("SLOT_UID_SPAN")) - 1;
  const lastUid = Number(setting("SLOT_UID_BASE")) + lastSlot;
  assert.ok(guide.includes(`Its log is \`${logs}/<user>.log\``), `the guide gives ${logs}`);
  assert.ok(guide.includes(`to slot ${lastSlot}, UID ${lastUid}`), `the guide ends the slots at ${lastSlot}, UID ${lastUid}`);
  assert.ok(guide.includes(`refuse once a host has given slot ${lastSlot}`));
  assert.match(helper, /fail "Could not lend slot \$id, so it is removed: /);
  assert.ok(guide.includes("A lend that fails, as when its server cannot be copied, sends the slot to `resetting`, and it is removed"));
});
