import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { headingAnchors } from "../src/llms.ts";
import { blankedCode } from "../src/repo.ts";

const dist = process.argv[2] ?? "dist";
const base = (process.env.SITE_BASE || "/").replace(/\/?$/, "/");
const siteRoot = process.env.SITE_URL ? new URL(base, process.env.SITE_URL).href : undefined;

function filesEndingWith(dir: string, endings: string[]): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesEndingWith(path, endings);
    return endings.some((ending) => entry.name.endsWith(ending)) ? [path] : [];
  });
}

const htmlFiles = (dir: string) => filesEndingWith(dir, [".html"]);
const markdownFiles = (dir: string) => [...filesEndingWith(dir, [".md"]), ...["llms.txt", "llms-full.txt"].map((name) => join(dir, name)).filter((path) => existsSync(path))];
const urlOf = (file: string) => `${base}${relative(dist, file).split("\\").join("/")}`;
const onThisSite = (reference: string) => (siteRoot && reference.startsWith(siteRoot) ? `${base}${reference.slice(siteRoot.length)}` : reference);
const isElsewhere = (reference: string) => /^[a-z][a-z+.-]*:/i.test(reference) || reference.startsWith("//");

const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

const idsByFile = new Map<string, Set<string>>();
const idsOf = (file: string) => {
  if (!idsByFile.has(file)) idsByFile.set(file, new Set([...readFileSync(file, "utf8").matchAll(/\sid="([^"]+)"/g)].map((match) => decode(match[1]!))));
  return idsByFile.get(file)!;
};

function fileFor(urlPath: string): string | undefined {
  const local = join(dist, decodeURIComponent(urlPath.slice(base.length)));
  if (existsSync(local) && statSync(local).isFile()) return local;
  if (existsSync(join(local, "index.html"))) return join(local, "index.html");
  if (existsSync(`${local}.html`)) return `${local}.html`;
  return undefined;
}

const pages = htmlFiles(dist);
const broken: string[] = [];
let checked = 0;
for (const page of pages) {
  const pageUrl = `${base}${relative(dist, page).split("\\").join("/").replace(/(^|\/)index\.html$/, "$1")}`;
  const html = readFileSync(page, "utf8").replace(/<pre\b[\s\S]*?<\/pre>/g, "");
  for (const match of html.matchAll(/<(?:a|link|img|script|source)\b[^>]*?\s(?:href|src)="([^"]*)"/g)) {
    const reference = decode(match[1]!);
    if (!reference || /^[a-z][a-z+.-]*:/i.test(reference) || reference.startsWith("//")) continue;
    checked++;
    const [path, fragment] = reference.split("#") as [string, string | undefined];
    const absolute = path ? (path.startsWith("/") ? path : posix.join(posix.dirname(`${pageUrl}x`), path)) : pageUrl;
    const target = absolute.startsWith(base) ? fileFor(absolute.split("?")[0]!) : undefined;
    if (!target) broken.push(`${pageUrl}: ${reference} (no page)`);
    else if (fragment && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(fragment))) broken.push(`${pageUrl}: ${reference} (no #${fragment} there)`);
  }
}

const anchorsByFile = new Map<string, Set<string>>();
const markdownAnchorsOf = (file: string) => {
  if (!anchorsByFile.has(file)) anchorsByFile.set(file, headingAnchors(readFileSync(file, "utf8")));
  return anchorsByFile.get(file)!;
};

const copies = markdownFiles(dist);
for (const copy of copies) {
  const copyUrl = urlOf(copy);
  const text = blankedCode(readFileSync(copy, "utf8")).replace(/`[^`\n]*`/g, "");
  for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const reference = onThisSite(match[1]!);
    if (isElsewhere(reference)) continue;
    checked++;
    const [path, fragment] = reference.split("#") as [string, string | undefined];
    const absolute = path ? (path.startsWith("/") ? path : posix.join(posix.dirname(copyUrl), path)) : copyUrl;
    const target = absolute.startsWith(base) ? fileFor(absolute) : undefined;
    if (!target) broken.push(`${copyUrl}: ${reference} (no page)`);
    else if (fragment && target.endsWith(".md") && !markdownAnchorsOf(target).has(decodeURIComponent(fragment))) broken.push(`${copyUrl}: ${reference} (no #${fragment} there)`);
  }
}

const llmsTxt = join(dist, "llms.txt");
const listed = existsSync(llmsTxt) ? new Set([...readFileSync(llmsTxt, "utf8").matchAll(/^- \[.*?\]\(([^)\s]+)\)/gm)].map((match) => onThisSite(match[1]!))) : new Set<string>();
const docsPages = pages.filter((page) => /.[\\/]index\.html$/.test(relative(dist, page)));
for (const page of docsPages) {
  const pageUrl = urlOf(dirname(page));
  if (!existsSync(`${dirname(page)}.md`) || !existsSync(join(dirname(page), "index.html.md"))) broken.push(`${pageUrl}/: no Markdown copy at ${pageUrl}.md and ${pageUrl}/index.html.md`);
  if (!listed.has(`${pageUrl}.md`)) broken.push(`${pageUrl}/: not in llms.txt`);
}

console.log(`Checked ${checked} internal links and assets on ${pages.length} pages and ${copies.length} Markdown files, and that llms.txt lists the ${docsPages.length} docs pages.`);
if (broken.length) {
  console.log(`${broken.length} broken:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("None broken.");
