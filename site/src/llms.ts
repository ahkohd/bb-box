import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { blankedCode, headingAnchor, inlineText, pageUrl, pagesByFile, repoRoot, repository, repositoryRef, siteHref, type Page, type PagesByFile } from "./repo.ts";
import { installCommand } from "./setup-prompt.ts";
import { sidebar } from "./sidebar.ts";
import { startingPoints, trustNote } from "./starting-points.ts";

export interface SiteAddress {
  base: string;
  site?: string;
}

export interface MarkdownCopy {
  page: Page;
  paths: string[];
  text: string;
}

interface Section {
  heading: string;
  pages: Page[];
}

interface Addresses {
  byFile: PagesByFile;
  idByUrl: Map<string, string>;
  site: SiteAddress;
}

const projectName = "BB Box";
const skippableGroup = "Decision records";
const skippableHeading = "Optional";
const decisionsIndex = "docs/decisions/README.md";

const imagePattern = /(!\[[^\]]*\]\(<?)([^)\s>]+)/g;
const linkPattern = /(?<!!)(\[(?:[^[\]]|\[[^\]]*\])*\]\(<?)([^)\s>]+)/g;
const leadingComment = /^\s*<!--[\s\S]*?-->\s*/;

export const markdownPath = (base: string, id: string) => `${pageUrl(base, id).replace(/\/$/, "")}.md`;
const indexMarkdownPath = (base: string, id: string) => `${pageUrl(base, id)}index.html.md`;
export const fullTextPath = (base: string) => `${base.replace(/\/?$/, "/")}llms-full.txt`;

export const absoluteAddress = (path: string, { site }: SiteAddress) => (site ? new URL(path, site).href : path);

const hasScheme = (href: string) => /^[a-z][a-z+.-]*:/i.test(href) || href.startsWith("//");
const asSentence = (words: string) => (/[.!?]$/.test(words) ? words : `${words}.`);
const escapedLinkText = (text: string) => text.replace(/[[\]]/g, "\\$&");
const withoutInlineCode = (text: string) => blankedCode(text).replace(/`[^`\n]*`/g, (span) => "x".repeat(span.length));
const withoutEmphasis = (text: string) => text.replace(/(^|\s)\*([^*\n]+)\*/g, "$1$2");

export function headingAnchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  for (const match of blankedCode(markdown).matchAll(/^#{1,6} (.+?)#*$/gm)) {
    const anchor = headingAnchor(inlineText(match[1]!.trim()));
    const count = seen.get(anchor) ?? 0;
    seen.set(anchor, count + 1);
    anchors.add(count ? `${anchor}-${count}` : anchor);
  }
  return anchors;
}

function replaceTargets(text: string, pattern: RegExp, replacement: (target: string) => string): string {
  let replaced = "";
  let copiedUpTo = 0;
  for (const match of withoutInlineCode(text).matchAll(pattern)) {
    const targetAt = match.index + match[1]!.length;
    replaced += text.slice(copiedUpTo, targetAt) + replacement(match[2]!);
    copiedUpTo = targetAt + match[2]!.length;
  }
  return replaced + text.slice(copiedUpTo);
}

function imageAddress(fromFile: string, target: string): string {
  if (hasScheme(target)) return target;
  const path = posix.normalize(posix.join(posix.dirname(fromFile), decodeURIComponent(target)));
  return existsSync(join(repoRoot, path)) ? `${repository}/raw/${repositoryRef}/${path}` : target;
}

function linkAddress(fromFile: string, target: string, addresses: Addresses): string {
  const href = siteHref(fromFile, target, addresses.byFile, addresses.site.base);
  const hashAt = href.indexOf("#");
  const id = addresses.idByUrl.get(hashAt === -1 ? href : href.slice(0, hashAt));
  if (id === undefined) return href;
  return absoluteAddress(markdownPath(addresses.site.base, id), addresses.site) + (hashAt === -1 ? "" : href.slice(hashAt));
}

function addressesFor(pages: Page[], site: SiteAddress): Addresses {
  return {
    byFile: pagesByFile(pages, (page) => headingAnchors(page.markdown)),
    idByUrl: new Map(pages.map((page) => [pageUrl(site.base, page.id), page.id])),
    site,
  };
}

function bodyOnSite(page: Page, addresses: Addresses): string {
  const body = page.markdown.replace(leadingComment, "");
  const withImages = replaceTargets(body, imagePattern, (target) => imageAddress(page.file, target));
  return replaceTargets(withImages, linkPattern, (target) => linkAddress(page.file, target, addresses));
}

function leadParagraph(page: Page): string | undefined {
  const paragraphs = blankedCode(page.markdown.replace(leadingComment, "")).split(/\n[ \t]*\n/);
  const lead = paragraphs.map((paragraph) => paragraph.trim()).find((paragraph) => /^[\p{L}`[*]/u.test(paragraph) && !paragraph.startsWith("[!") && !/^\*\s/.test(paragraph) && !/^Status:/i.test(paragraph));
  return lead && withoutEmphasis(inlineText(lead.replace(/\s*\n\s*/g, " ")));
}

function leadSentence(page: Page): string | undefined {
  const lead = leadParagraph(page);
  return lead && (/^.+?[.!?](?=\s|$)/.exec(lead)?.[0] ?? lead);
}

function decisionStatuses(pages: Page[]): Map<string, string> {
  const index = pages.find((page) => page.file === decisionsIndex);
  const rows = index ? [...blankedCode(index.markdown).matchAll(/^\| \[[^\]]+\]\(([^)]+)\) \| .+? \| (.+?) \|$/gm)] : [];
  return new Map(rows.map((row) => [posix.join(posix.dirname(decisionsIndex), row[1]!), asSentence(inlineText(row[2]!))]));
}

export function descriptions(pages: Page[]): Map<string, string> {
  const words = new Map(startingPoints.map((point) => [point.id, point.words]));
  const statuses = decisionStatuses(pages);
  return new Map(pages.map((page) => [page.id, page.description ?? words.get(page.id) ?? statuses.get(page.file) ?? leadSentence(page) ?? page.title]));
}

function summary(pages: Page[]): string {
  const introduction = pages.find((page) => page.id === "start");
  const lead = introduction && leadParagraph(introduction);
  if (!lead) throw new Error("llms.txt takes its summary from the README's first paragraph, and the README has none");
  return lead;
}

function inLastSectionOnly(all: Section[]): Section[] {
  const lastSection = new Map(all.flatMap((section) => section.pages.map((page) => [page.id, section] as const)));
  return all.map((section) => ({ ...section, pages: section.pages.filter((page) => lastSection.get(page.id) === section) }));
}

function sections(pages: Page[]): Section[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const all = sidebar(pages).map((group) => ({
    heading: group.label === skippableGroup ? skippableHeading : group.label,
    pages: group.items.map((item) => byId.get(item.slug)!),
  }));
  return inLastSectionOnly(all);
}

export function markdownCopies(pages: Page[], site: SiteAddress): MarkdownCopy[] {
  const addresses = addressesFor(pages, site);
  return pages.map((page) => ({
    page,
    paths: [markdownPath(site.base, page.id), indexMarkdownPath(site.base, page.id)],
    text: `# ${page.title}\n\n${bodyOnSite(page, addresses)}`,
  }));
}

export function llmsTxt(pages: Page[], site: SiteAddress): string {
  const described = descriptions(pages);
  const linkTo = (page: Page) => `- [${escapedLinkText(page.title)}](${absoluteAddress(markdownPath(site.base, page.id), site)}): ${described.get(page.id)}`;
  const intro = [
    `# ${projectName}`,
    `> ${summary(pages)}`,
    `bb-box is a plugin for [BB](https://getbb.app). An agent installs it with \`${installCommand(pages)} --yes\`, then sets up a backend as the quick start says: Docker on the machine that runs BB is the quickest. ${trustNote}`,
    `Each link below is a page of this site in Markdown. [llms-full.txt](${absoluteAddress(fullTextPath(site.base), site)}) has every page in one file. The decision records, under ${skippableHeading}, say why bb-box is built as it is.`,
  ];
  const lists = sections(pages).map((section) => [`## ${section.heading}`, section.pages.map(linkTo).join("\n")].join("\n\n"));
  return `${[...intro, ...lists].join("\n\n")}\n`;
}

export function llmsFullTxt(pages: Page[], site: SiteAddress): string {
  const addresses = addressesFor(pages, site);
  const inOrder = sections(pages).flatMap((section) => section.pages);
  const copies = inOrder.map((page) => [`# ${page.title}`, `Source: ${absoluteAddress(pageUrl(site.base, page.id), site)}`, bodyOnSite(page, addresses).trimEnd()].join("\n\n"));
  return `${[`# ${projectName}`, `> ${summary(pages)}`, ...copies].join("\n\n")}\n`;
}
