import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { fileURLToPath } from "node:url";

function checkoutAbove(directory: string): string {
  if (existsSync(join(directory, "site", "astro.config.ts"))) return join(directory, sep);
  const parent = dirname(directory);
  if (parent === directory) throw new Error("The site reads bb-box's Markdown from the checkout it is built in, and found no checkout above its code");
  return checkoutAbove(parent);
}

export const repoRoot = checkoutAbove(fileURLToPath(new URL(".", import.meta.url)));
export const repository = "https://github.com/ahkohd/bb-box";
export const repositoryRef = process.env.SITE_REPOSITORY_REF || "main";

export interface Page {
  id: string;
  file: string;
  title: string;
  titleAnchor: string;
  description?: string;
  body: string;
  markdown: string;
}

interface Source {
  id: string;
  file: string;
  title?: string;
  onlySection?: string;
  withoutSection?: string;
}

export const quickStartSection = "Quick start";

const readText = (file: string) => readFileSync(join(repoRoot, file), "utf8");

function markdownFilesIn(dir: string, { deep }: { deep: boolean }): string[] {
  if (!existsSync(join(repoRoot, dir))) return [];
  return readdirSync(join(repoRoot, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const path = posix.join(dir, entry.name);
      if (entry.isDirectory()) return deep && entry.name !== "node_modules" ? markdownFilesIn(path, { deep }) : [];
      return entry.name.endsWith(".md") ? [path] : [];
    })
    .sort();
}

function idForFile(file: string): string {
  const withoutExtension = file.replace(/\.md$/, "");
  const withoutReadme = withoutExtension.replace(/(^|\/)README$/, "");
  return withoutReadme.replace(/^docs\//, "").toLowerCase();
}

const setupGuides = () => markdownFilesIn("setup", { deep: true }).filter((file) => file.endsWith("/README.md") || file === "setup/README.md");

function sources(): Source[] {
  return [
    { id: "start", file: "README.md", title: "Introduction", withoutSection: quickStartSection },
    { id: "start/quick-start", file: "README.md", title: quickStartSection, onlySection: quickStartSection },
    ...markdownFilesIn("docs/guide", { deep: true }).map((file) => ({ id: idForFile(file), file })),
    ...markdownFilesIn("docs/reference", { deep: true }).map((file) => ({ id: idForFile(file), file })),
    ...setupGuides().map((file) => ({ id: idForFile(file), file })),
    { id: "agent-skill", file: "skills/bb-box/SKILL.md" },
    ...["docs/architecture.md", "docs/development.md", "docs/bb-requests.md"].map((file) => ({ id: idForFile(file), file })),
    ...markdownFilesIn("docs/decisions", { deep: false }).map((file) => ({ id: idForFile(file), file })),
  ].filter((source) => existsSync(join(repoRoot, source.file)));
}

export function withoutFrontmatter(text: string): { frontmatter: Record<string, string>; content: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return { frontmatter: {}, content: text };
  const frontmatter = Object.fromEntries(
    match[1]!
      .split("\n")
      .map((line) => /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line))
      .filter((pair) => pair !== null)
      .map((pair) => [pair[1]!, pair[2]!.replace(/^(["'])(.*)\1$/, "$2")]),
  );
  return { frontmatter, content: text.slice(match[0].length) };
}

export function blankedCode(text: string): string {
  return text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, (block) => block.replace(/[^\n]/g, " "));
}

export const inlineText = (markdown: string) =>
  markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`|\*\*/g, "")
    .trim();

export const headingAnchor = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/ /g, "-");

function splitTitle(content: string): { title: string; body: string } {
  const code = blankedCode(content);
  const match = /^# (.+)$/m.exec(code);
  if (!match) return { title: "", body: content };
  return {
    title: inlineText(content.slice(match.index + 2, match.index + match[0].length)),
    body: content.slice(0, match.index) + content.slice(match.index + match[0].length),
  };
}

interface Section {
  heading: string;
  start: number;
  end: number;
}

function secondLevelSections(body: string): Section[] {
  const code = blankedCode(body);
  const starts = [...code.matchAll(/^## (.+)$/gm)].map((match) => ({ heading: inlineText(match[1]!), start: match.index }));
  return starts.map((section, i) => ({ ...section, end: starts[i + 1]?.start ?? body.length }));
}

function sectionOf(body: string, heading: string, file: string): Section {
  const section = secondLevelSections(body).find((candidate) => candidate.heading === heading);
  if (!section) throw new Error(`The site expects a "## ${heading}" section in ${file}`);
  return section;
}

export const lightTwinOf = (path: string) => path.replace(/(-2x)?(\.[a-z]+)$/i, "-light$1$2");

export function withLightTwins(body: string, file: string): string {
  const code = blankedCode(body);
  let paired = "";
  let copiedUpTo = 0;
  for (const image of code.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
    const [markdown, alt, path] = image;
    if (hasScheme(path!) || /-light(-2x)?\.[a-z]+$/i.test(path!)) continue;
    const twin = lightTwinOf(path!);
    if (twin === path || !existsSync(join(repoRoot, posix.join(dirname(file), twin)))) continue;
    const end = image.index + markdown.length;
    paired += body.slice(copiedUpTo, end) + `![${alt}](${twin})`;
    copiedUpTo = end;
  }
  return paired + body.slice(copiedUpTo);
}

const githubVideo = /^https:\/\/github\.com\/user-attachments\/assets\/\S+\n+/gm;

function pageFrom(source: Source): Page {
  const { frontmatter, content } = withoutFrontmatter(readText(source.file));
  const { title, body } = splitTitle(content);
  let pageBody = body;
  let titleAnchor = headingAnchor(title);
  if (source.onlySection) {
    const section = sectionOf(body, source.onlySection, source.file);
    pageBody = body.slice(section.start, section.end).replace(/^## .+\n/, "");
    titleAnchor = headingAnchor(section.heading);
  }
  if (source.withoutSection) {
    const section = sectionOf(body, source.withoutSection, source.file);
    pageBody = body.slice(0, section.start) + body.slice(section.end);
  }
  pageBody = pageBody.replace(githubVideo, "");
  return {
    id: source.id,
    file: source.file,
    title: source.title ?? (title || source.id),
    titleAnchor,
    description: frontmatter.description,
    body: withLightTwins(pageBody.trim(), source.file) + "\n",
    markdown: pageBody.trim() + "\n",
  };
}

export function readPages(): Page[] {
  const pages = sources().map(pageFrom);
  const seen = new Set<string>();
  for (const page of pages) {
    if (seen.has(page.id)) throw new Error(`Two files make the site page ${page.id}`);
    seen.add(page.id);
  }
  return pages;
}

export interface PageAnchors {
  id: string;
  titleAnchor: string;
  anchors: Set<string>;
}

export type PagesByFile = Map<string, PageAnchors[]>;

export function pagesByFile(pages: Page[], anchorsOf: (page: Page) => Iterable<string>): PagesByFile {
  const byFile: PagesByFile = new Map();
  for (const page of pages) byFile.set(page.file, [...(byFile.get(page.file) ?? []), { id: page.id, titleAnchor: page.titleAnchor, anchors: new Set(anchorsOf(page)) }]);
  return byFile;
}

const hasScheme = (href: string) => /^[a-z][a-z+.-]*:/i.test(href) || href.startsWith("//");

export const pageUrl = (base: string, id: string) => `${base.replace(/\/?$/, "/")}${id ? `${id}/` : ""}`;

function repositoryUrl(path: string): string {
  const isDirectory = statSync(join(repoRoot, path)).isDirectory();
  return `${repository}/${isDirectory ? "tree" : "blob"}/${repositoryRef}/${path}`;
}

function pageFor(candidates: PageAnchors[] | undefined, fragment: string | undefined): PageAnchors | undefined {
  if (!candidates?.length) return undefined;
  if (!fragment) return candidates[0];
  const anchor = fragment.toLowerCase();
  return candidates.find((candidate) => candidate.anchors.has(anchor) || candidate.titleAnchor === anchor) ?? candidates[0];
}

export function siteHref(fromFile: string, href: string, byFile: PagesByFile, base: string): string {
  if (!href || hasScheme(href)) return href;
  const hashAt = href.indexOf("#");
  const path = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? undefined : href.slice(hashAt + 1);
  const resolved = path.startsWith("/") ? posix.normalize(path.slice(1)) : posix.normalize(posix.join(dirname(fromFile), decodeURIComponent(path)));
  const target = resolved === "." ? "" : resolved.replace(/\/$/, "");
  if (target.startsWith("..")) return href;
  const file = !path ? fromFile : existsSync(join(repoRoot, target, "README.md")) && statSync(join(repoRoot, target)).isDirectory() ? posix.join(target, "README.md").replace(/^\//, "") : target;
  const page = pageFor(byFile.get(file), fragment);
  const suffix = fragment && fragment.toLowerCase() !== page?.titleAnchor ? `#${fragment.toLowerCase()}` : "";
  if (page) return `${pageUrl(base, page.id)}${suffix}`;
  if (existsSync(join(repoRoot, target))) return `${repositoryUrl(target)}${fragment ? `#${fragment}` : ""}`;
  return href;
}

const decodeAttribute = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const encodeAttribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

export function rewriteLinks(html: string, fromFile: string, byFile: PagesByFile, base: string): string {
  return html.replace(/(<a\b[^>]*?\shref=")([^"]*)(")/g, (_, before: string, href: string, after: string) => `${before}${encodeAttribute(siteHref(fromFile, decodeAttribute(href), byFile, base))}${after}`);
}

export interface IndexLink {
  text: string;
  target: string;
}

export function indexLinks(file: string, { tablesOnly = false, section }: { tablesOnly?: boolean; section?: string } = {}): IndexLink[] {
  if (!existsSync(join(repoRoot, file))) return [];
  let text = blankedCode(readText(file));
  if (section) {
    const found = secondLevelSections(text).find((candidate) => candidate.heading === section);
    text = found ? text.slice(found.start, found.end) : "";
  }
  const lines = text.split("\n").filter((line) => (tablesOnly ? line.startsWith("|") : true));
  return lines.flatMap((line) =>
    [...line.replace(/`([^`\n]*)`/g, "$1").matchAll(/(?<!!)\[([^\]]+)\]\(<?([^)\s>]+)>?\)/g)]
      .filter((match) => !hasScheme(match[2]!))
      .map((match) => ({ text: inlineText(match[1]!), target: match[2]! })),
  );
}

export function idOfLink(fromFile: string, link: IndexLink, pages: Page[]): string | undefined {
  const href = siteHref(fromFile, link.target.split("#")[0]!, pagesByFile(pages, () => []), "/");
  if (!href.startsWith("/")) return undefined;
  return href.slice(1).replace(/\/$/, "");
}
