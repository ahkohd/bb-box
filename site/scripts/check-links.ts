import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const dist = process.argv[2] ?? "dist";
const base = (process.env.SITE_BASE || "/").replace(/\/?$/, "/");

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });
}

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

console.log(`Checked ${checked} internal links and assets on ${pages.length} pages.`);
if (broken.length) {
  console.log(`${broken.length} broken:\n${broken.join("\n")}`);
  process.exit(1);
}
console.log("None broken.");
