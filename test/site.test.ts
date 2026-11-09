import assert from "node:assert/strict";
import { test } from "node:test";
import { anchor } from "../scripts/reference.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homePageHead, icons, shareImage, siteHead, type HeadTag } from "../site/src/head.ts";
import { descriptions, entryData, fullTextPath, headingAnchors as anchorsInMarkdown, llmsFullTxt, llmsTxt, markdownCopies, markdownPath } from "../site/src/llms.ts";
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

test("the home page's demo can always be paused: each of its videos has controls, with JavaScript and without", () => {
  const demo = readFileSync(join(repoRoot, "site", "src", "components", "home", "DemoVideo.astro"), "utf8");
  const videos = [...demo.matchAll(/<video\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(videos.length, 2);
  assert.deepEqual(videos.filter((video) => !/\scontrols\s/.test(video)), []);
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
  assert.equal(blocks[0], "# BB Box");
  assert.match(blocks[1]!, /^> \S[^\n]+$/);

  const headings = [...text.matchAll(/^(#+) (.+)$/gm)].map((match) => `${match[1]} ${match[2]}`);
  assert.equal(headings[0], "# BB Box");
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

test("the home page's setup prompt installs BB Box as the quick start does, with only bb box commands the CLI has, its setup skill, and a backend for each platform", () => {
  const command = installCommand(pages);
  const quickStart = pages.find((page) => page.id === "start/quick-start")!.markdown.replace(/\s+/g, " ");
  assert.match(command, /^bb plugin install git:\S+$/);
  assert.ok(quickStart.includes(command));

  const prompt = setupPrompt(pages, "https://docs.example.com/start/quick-start.md");
  assert.ok(prompt.startsWith("Set up BB Box for me"), "the prompt is the README's With an agent block");
  assert.ok(prompt.includes(`${command} --yes`), "an agent cannot answer the install's confirmation");
  assert.ok(prompt.endsWith("https://docs.example.com/start/quick-start.md"));

  const cli = pages.find((page) => page.id === "reference/cli")!.markdown;
  const commands = [...cli.matchAll(/^## (bb box .+)$/gm)].map((match) => match[1]!);
  const named = [...prompt.matchAll(/\bbb box [a-z][a-z-]*(?: [a-z][a-z-]*)?/g)].map((match) => match[0]);
  assert.ok(named.length >= 5);
  assert.deepEqual(named.filter((words) => !commands.some((usage) => words === usage || words.startsWith(`${usage} `))), [], "commands the CLI does not have");
  assert.ok(commands.includes("bb box setup docker"));
  assert.ok(prompt.includes("bb box acquire"), "the prompt proves the setup with a box");

  const skill = withoutFrontmatter(readFileSync(join(repoRoot, "skills", "bb-box-setup", "SKILL.md"), "utf8")).frontmatter.name!;
  assert.ok(prompt.includes(`its ${skill} skill`));

  for (const backend of ["Docker", "microsandbox"]) assert.ok(prompt.includes(backend), `the prompt names ${backend}, as the quick start's platforms do`);
});

const siteDescription = /description: "([^"]+)"/.exec(readFileSync(join(repoRoot, "site", "astro.config.ts"), "utf8"))![1]!;
const publishedSite = /SITE_URL: (\S+)/.exec(readFileSync(join(repoRoot, ".github", "workflows", "docs.yml"), "utf8"))![1]!;
const searchSnippetLength = 160;

function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file);
  assert.equal(png.toString("latin1", 1, 4), "PNG", `${file} is not a PNG`);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const metaContent = (head: HeadTag[], key: string) => head.find((tag) => tag.tag === "meta" && (tag.attrs.property === key || tag.attrs.name === key))?.attrs.content;

test("each page of the site has a search description of its own, not the site's tagline or its title", () => {
  const data = entryData(pages);
  assert.deepEqual(pages.filter((page) => !data.get(page.id)?.description).map((page) => page.id), [], "pages without a description");
  assert.deepEqual(pages.filter((page) => data.get(page.id)!.description === siteDescription).map((page) => page.id), [], "pages with the site's tagline");
  assert.deepEqual(pages.filter((page) => data.get(page.id)!.description === page.title).map((page) => page.id), [], "pages described by their title");
  const tooLong = pages.filter((page) => !page.description && data.get(page.id)!.description!.length > searchSnippetLength);
  assert.deepEqual(tooLong.map((page) => page.id), [], `descriptions longer than ${searchSnippetLength} characters`);
  const described = pages.map((page) => data.get(page.id)!.description);
  assert.deepEqual(pages.filter((_, i) => described.indexOf(described[i]) !== i).map((page) => page.id), [], "pages that share a description");
  assert.equal(data.get("decisions/001-provider-agnostic-core")!.description, "BB Box decision record 001. Status now: Current.");
  assert.equal(data.get("guide/boat")!.description, "boat.dev rents Linux virtual machines, which it calls sandboxes, by the second.");
});

test("every page shares the site's card as an absolute image with its size and alt text, and links its PNG icons", () => {
  assert.match(readFileSync(join(repoRoot, "site", "astro.config.ts"), "utf8"), /^\s+head: siteHead\(\{ site, base \}\),$/m, "the site's config gives Starlight the share image and icons");
  const head = siteHead({ site: publishedSite, base: "/" });
  const card = pngSize(join(repoRoot, "site", "public", shareImage.path));
  assert.deepEqual(card, { width: 1200, height: 630 });
  assert.equal(metaContent(head, "og:image"), `${publishedSite}/og.png`);
  assert.equal(metaContent(head, "twitter:image"), `${publishedSite}/og.png`);
  assert.equal(metaContent(head, "og:image:width"), String(card.width));
  assert.equal(metaContent(head, "og:image:height"), String(card.height));
  assert.ok(metaContent(head, "og:image:alt")!.startsWith("BB Box: computers for BB threads."));

  assert.equal(metaContent(siteHead({ site: "https://example.com", base: "/docs/" }), "og:image"), "https://example.com/docs/og.png");
  assert.equal(metaContent(siteHead({ base: "/" }), "og:image"), undefined, "a share image needs an absolute address, so a build without a site has none");

  const linked = head.filter((tag) => tag.tag === "link");
  assert.deepEqual(
    linked.map((tag) => [tag.attrs.rel, tag.attrs.href, tag.attrs.sizes]),
    [
      ["icon", `/${icons.png.path}`, "32x32"],
      ["apple-touch-icon", `/${icons.appleTouch.path}`, "180x180"],
    ],
  );
  assert.deepEqual(pngSize(join(repoRoot, "site", "public", icons.png.path)), { width: 32, height: 32 });
  assert.deepEqual(pngSize(join(repoRoot, "site", "public", icons.appleTouch.path)), { width: 180, height: 180 });
  assert.deepEqual(pngSize(join(repoRoot, "site", "og", "github-social.png")), { width: 1280, height: 640 });
});

test("the home page says it is a website, not an article, and robots.txt lets every crawler in and names the sitemap", () => {
  assert.equal(metaContent(homePageHead, "og:type"), "website");
  assert.match(readFileSync(join(repoRoot, "site", "src", "pages", "index.astro"), "utf8"), /^\s+head: homePageHead,$/m);
  const robots = readFileSync(join(repoRoot, "site", "public", "robots.txt"), "utf8");
  assert.match(robots, /^User-agent: \*\nAllow: \/$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${publishedSite}/sitemap-index\\.xml$`, "m"));
});
