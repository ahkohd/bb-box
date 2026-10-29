import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Loader, LoaderContext } from "astro/loaders";
import { pagesByFile, readPages, repoRoot, rewriteLinks, type Page } from "./repo.ts";

const watchedFolders = ["README.md", "docs", "setup", "skills"].map((path) => join(repoRoot, path));

const isRecord = (page: Page) => page.id.startsWith("decisions/");

function searchWeighted(page: Page, html: string): string {
  return isRecord(page) ? `<div data-pagefind-weight="0.2">${html}</div>` : html;
}

async function loadPages({ store, parseData, renderMarkdown, generateDigest, config }: LoaderContext): Promise<void> {
  const pages = readPages();
  const rendered = await Promise.all(pages.map((page) => renderMarkdown(page.body, { fileURL: pathToFileURL(join(repoRoot, page.file)) })));
  const anchors = new Map(pages.map((page, i) => [page, rendered[i]!.metadata?.headings?.map((heading) => heading.slug) ?? []]));
  const byFile = pagesByFile(pages, (page) => anchors.get(page)!);
  store.clear();
  for (const [i, page] of pages.entries()) {
    const data = await parseData({ id: page.id, data: { title: page.title, ...(page.description ? { description: page.description } : {}) } });
    const html = searchWeighted(page, rewriteLinks(rendered[i]!.html, page.file, byFile, config.base));
    store.set({
      id: page.id,
      data,
      body: page.body,
      filePath: relative(fileURLToPath(config.root), join(repoRoot, page.file)),
      digest: generateDigest(page.body),
      rendered: { ...rendered[i]!, html },
      assetImports: rendered[i]!.metadata?.imagePaths,
    });
  }
}

export function repositoryDocs(): Loader {
  return {
    name: "bb-box-repository-docs",
    async load(context) {
      await loadPages(context);
      context.watcher?.add(watchedFolders);
      context.watcher?.on("all", async (_, path) => {
        if (path.endsWith(".md") && watchedFolders.some((folder) => path.startsWith(folder))) await loadPages(context);
      });
    },
  };
}
