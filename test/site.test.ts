import assert from "node:assert/strict";
import { test } from "node:test";
import { anchor } from "../scripts/reference.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIND_INFO } from "../src/backends/kinds.ts";
import { descriptions, fullTextPath, headingAnchors as anchorsInMarkdown, llmsFullTxt, llmsTxt, markdownCopies, markdownPath } from "../site/src/llms.ts";
import { blankedCode, lightTwinOf, pagesByFile, readPages, repoRoot, repository, siteHref, withoutFrontmatter, type Page } from "../site/src/repo.ts";
import { installCommand, setupPrompt } from "../site/src/setup-prompt.ts";
import { sidebar } from "../site/src/sidebar.ts";
import { repositoryFiles } from "./repository-files.ts";

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
  const expected = repositoryFiles(repoRoot, (path) => /^docs\/(guide|reference)\/.*\.md$/.test(path) || /^setup\/.*README\.md$/.test(path));
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

const onSite = { base: "/" };

const markdownLinks = (text: string) => [...blankedCode(text).replace(/`[^`\n]*`/g, "").matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)].map((match) => match[1]!);

test("llms.txt is as llmstxt.org lays it out, and lists every page of the site once, with what it is, as Markdown", () => {
  const text = llmsTxt(pages, onSite);
  const blocks = text.split("\n\n");
  assert.equal(blocks[0], "# bb-box");
  assert.match(blocks[1]!, /^> \S[^\n]+$/);

  const headings = [...text.matchAll(/^(#+) (.+)$/gm)].map((match) => `${match[1]} ${match[2]}`);
  assert.equal(headings[0], "# bb-box");
  assert.ok(headings.slice(1).every((heading) => heading.startsWith("## ")), "only sections after the title");
  assert.equal(headings.at(-1), "## Optional", "the decision records come last, as the part an agent may skip");

  const items = [...text.matchAll(/^- \[(.+)\]\(([^)]+)\): (.+)$/gm)];
  const listed = items.map((item) => item[2]!);
  assert.deepEqual(pages.map((page) => markdownPath("/", page.id)).filter((path) => !listed.includes(path)), [], "pages missing from llms.txt");
  assert.equal(new Set(listed).size, listed.length, "a page listed twice");
  assert.deepEqual(items.filter((item) => !/\S[.!?]$/.test(item[3]!)).map((item) => item[0]), [], "an item without a sentence that says what it is");
});

test("each page's description comes from what the page or its index says, not its title", () => {
  const described = descriptions(pages);
  assert.deepEqual(pages.filter((page) => described.get(page.id) === page.title).map((page) => page.id), []);
  assert.equal(described.get("decisions/001-provider-agnostic-core"), "Current.");
});

test("every link in llms.txt, llms-full.txt and each page's Markdown copy leads to a Markdown copy, to a heading in it, or to a file in the repository", () => {
  const copies = markdownCopies(pages, onSite);
  const served = new Map(copies.flatMap((copy) => copy.paths.map((path) => [path, copy.text] as const)));
  const documents: [string, string][] = [["llms.txt", llmsTxt(pages, onSite)], ["llms-full.txt", llmsFullTxt(pages, onSite)], ...copies.map((copy): [string, string] => [copy.paths[0]!, copy.text])];
  const broken: string[] = [];
  for (const [name, text] of documents) {
    for (const href of markdownLinks(text)) {
      const [path, fragment] = href.split("#") as [string, string | undefined];
      const inRepository = path.startsWith(`${repository}/`) && /^\/(?:blob|tree|raw)\/[^/]+\/(.+)$/.exec(path.slice(repository.length));
      if (inRepository) {
        if (!existsSync(join(repoRoot, decodeURIComponent(inRepository[1]!)))) broken.push(`${name}: ${href} (no such file)`);
      } else if (/^[a-z][a-z+.-]*:/i.test(href) || path === fullTextPath("/")) {
        continue;
      } else if (!served.has(path)) {
        broken.push(`${name}: ${href} (no Markdown copy there)`);
      } else if (fragment && !anchorsInMarkdown(served.get(path)!).has(fragment)) {
        broken.push(`${name}: ${href} (no heading there)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("each page's Markdown copy is served at its address with .md and with index.html.md, and has its title and its Markdown as written, without the site's light twins", () => {
  const copies = markdownCopies(pages, onSite);
  assert.deepEqual(
    copies.filter((copy) => copy.paths.join(" ") !== `/${copy.page.id}.md /${copy.page.id}/index.html.md`).map((copy) => copy.page.id),
    [],
  );
  assert.deepEqual(copies.filter((copy) => !copy.text.startsWith(`# ${copy.page.title}\n\n`)).map((copy) => copy.page.id), []);
  const pairedWithTwin = (text: string) => [...text.matchAll(/\]\(([^)\s]+)\)!\[[^\]]*\]\(([^)\s]+)\)/g)].some((pair) => pair[2] === lightTwinOf(pair[1]!));
  assert.ok(pages.some((page) => pairedWithTwin(page.body)), "the site pairs some screenshots with their light twins");
  assert.deepEqual(copies.filter((copy) => pairedWithTwin(copy.text)).map((copy) => copy.page.id), []);
  const full = llmsFullTxt(pages, onSite);
  assert.deepEqual(pages.filter((page) => !full.includes(`\n# ${page.title}\n\nSource: /${page.id}/\n`)).map((page) => page.id), [], "pages missing from llms-full.txt");
});

test("the home page's setup prompt installs BB Box as the quick start does, with only bb box commands the CLI has, its setup skill and the quick start's numbers", () => {
  const command = installCommand(pages);
  const quickStart = pages.find((page) => page.id === "start/quick-start")!.markdown.replace(/\s+/g, " ");
  assert.match(command, /^bb plugin install git:\S+$/);
  assert.ok(quickStart.includes(command));

  const prompt = setupPrompt(command, "https://docs.example.com/start/quick-start.md");
  assert.ok(prompt.includes(`${command} --yes`), "an agent cannot answer the install's confirmation");
  assert.ok(prompt.endsWith("https://docs.example.com/start/quick-start.md"));

  const cli = pages.find((page) => page.id === "reference/cli")!.markdown;
  const commands = [...cli.matchAll(/^## (bb box .+)$/gm)].map((match) => match[1]!);
  const named = [...prompt.matchAll(/\bbb box [a-z][a-z-]*(?: [a-z][a-z-]*)?/g)].map((match) => match[0]);
  assert.ok(named.length >= 5);
  assert.deepEqual(named.filter((words) => !commands.some((usage) => words === usage || words.startsWith(`${usage} `))), [], "commands the CLI does not have");
  assert.ok(commands.includes("bb box setup docker"));
  assert.ok(/bb box acquire (\S+),/.exec(prompt)![1]! in KIND_INFO);

  const skill = withoutFrontmatter(readFileSync(join(repoRoot, "skills", "bb-box-setup", "SKILL.md"), "utf8")).frontmatter.name!;
  assert.ok(prompt.includes(`its ${skill} skill`));

  const minutes = /(\d+ to \d+ minutes)/.exec(prompt)![1]!;
  assert.ok(quickStart.includes(`Linux image usually builds in ${minutes}`));
  const [, disk, memory] = /about (\d+ GB) of free disk and (\d+ GiB) of memory/.exec(prompt)!;
  assert.ok(quickStart.includes(`about ${disk} of disk free and at least ${memory} of memory`));
});
