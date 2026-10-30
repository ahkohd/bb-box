import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { anchor } from "../scripts/reference.ts";
import { readdirSync } from "node:fs";
import { blankedCode, lightTwinOf, pagesByFile, readPages, repoRoot, repository, siteHref, type Page } from "../site/src/repo.ts";
import { sidebar } from "../site/src/sidebar.ts";

const pages = readPages();

function headingAnchors(page: Page): string[] {
  const seen = new Map<string, number>();
  return [...blankedCode(page.body).matchAll(/^#{2,6} (.+?)#*$/gm)].map((match) => {
    const base = anchor(match[1]!.trim().replace(/`/g, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  });
}

test("the site has the getting-started path and a page for every guide, backend guide and reference page", () => {
  const ids = new Set(pages.map((page) => page.id));
  for (const id of ["start", "start/quick-start", "setup", "guide", "reference", "reference/tools", "reference/cli", "agent-skill"]) assert.ok(ids.has(id), `the site has no page ${id}`);
  const files = new Set(pages.map((page) => page.file));
  const expected = execFileSync("git", ["ls-files", "docs/guide/*.md", "docs/reference/*.md", "setup/*README.md"], { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);
  assert.deepEqual(
    expected.filter((file) => !files.has(file)),
    [],
  );
});

test("every page of the site is in its sidebar once a section lists it", () => {
  const listed = new Set(sidebar(pages).flatMap((group) => group.items.map((item) => item.slug)));
  assert.deepEqual(
    pages.map((page) => page.id).filter((id) => !listed.has(id)),
    [],
  );
});

test("every link on a page of the site leads to a page of the site, or to a file in the repository", () => {
  const anchors = new Map(pages.map((page) => [page, headingAnchors(page)]));
  const byFile = pagesByFile(pages, (page) => anchors.get(page)!);
  const pageAnchors = new Map(pages.map((page) => [`/${page.id}/`, new Set(anchors.get(page))]));
  const broken: string[] = [];
  for (const page of pages) {
    const text = blankedCode(page.body).replace(/`[^`\n]*`/g, "");
    for (const match of text.matchAll(/\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
      const href = match[1]!;
      if (/^[a-z][a-z+.-]*:/i.test(href) || /\.(png|webp|jpe?g|gif|svg)$/i.test(href)) continue;
      const to = siteHref(page.file, href, byFile, "/");
      const [path, fragment] = to.split("#") as [string, string | undefined];
      if (to.startsWith(`${repository}/`)) continue;
      if (!pageAnchors.has(path)) broken.push(`${page.file}: ${href} -> ${to}`);
      else if (fragment && !pageAnchors.get(path)!.has(fragment)) broken.push(`${page.file}: ${href} -> ${to} (no heading there)`);
    }
  }
  assert.deepEqual(broken, []);
});

test("each screenshot in docs/media with a light twin is followed by it on the site, which shows the one for its theme", () => {
  const twins = readdirSync(`${repoRoot}docs/media`).filter((name) => /-light(-2x)?\.[a-z]+$/.test(name));
  const unpaired = twins.filter((twin) => {
    const dark = twin.replace(/-light(-2x)?\./, "$1.");
    return !pages.some((page) => new RegExp(`\\]\\([^)]*/${dark}\\)!\\[[^\\]]*\\]\\([^)]*/${lightTwinOf(dark)}\\)`).test(page.body));
  });
  assert.deepEqual(unpaired, []);
});
