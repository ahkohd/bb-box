import { idOfLink, indexLinks, type IndexLink, type Page } from "./repo.ts";

export interface SidebarLink {
  slug: string;
  label: string;
}

export interface SidebarGroup {
  label: string;
  collapsed?: boolean;
  items: SidebarLink[];
}

interface LinkedFrom {
  file: string;
  links: IndexLink[];
}

const linksOf = (file: string, options?: Parameters<typeof indexLinks>[1]): LinkedFrom => ({ file, links: indexLinks(file, options) });

function orderedPages(pages: Page[], indexes: LinkedFrom[], belongs: (page: Page) => boolean, labelFromIndex = true): SidebarLink[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const items: SidebarLink[] = [];
  const placed = new Set<string>();
  for (const index of indexes) {
    for (const link of index.links) {
      const id = idOfLink(index.file, link, pages);
      const page = id === undefined ? undefined : byId.get(id);
      if (!page || placed.has(page.id) || !belongs(page)) continue;
      placed.add(page.id);
      items.push({ slug: page.id, label: labelFromIndex ? link.text : page.title });
    }
  }
  const unlisted = pages.filter((page) => belongs(page) && !placed.has(page.id)).sort((a, b) => a.id.localeCompare(b.id));
  return [...items, ...unlisted.map((page) => ({ slug: page.id, label: page.title }))];
}

const under = (prefix: string) => (page: Page) => page.id.startsWith(`${prefix}/`);

function existing(pages: Page[], items: SidebarLink[]): SidebarLink[] {
  const ids = new Set(pages.map((page) => page.id));
  return items.filter((item) => ids.has(item.slug));
}

export function sidebar(pages: Page[]): SidebarGroup[] {
  const backendIndexes = [linksOf("setup/README.md", { section: "Choose a backend", tablesOnly: true }), linksOf("README.md", { section: "Backends and boxes", tablesOnly: true })];
  const isBackendGuide = (page: Page) => under("setup")(page) || backendIndexes.some((index) => index.links.some((link) => idOfLink(index.file, link, pages) === page.id));
  const groups: SidebarGroup[] = [
    {
      label: "Start here",
      items: existing(pages, [
        { slug: "start", label: "Introduction" },
        { slug: "start/quick-start", label: "Quick start" },
        { slug: "setup", label: "Setting up BB Box" },
      ]),
    },
    {
      label: "User guide",
      items: [...existing(pages, [{ slug: "guide", label: "Overview" }]), ...orderedPages(pages, [linksOf("docs/guide/README.md")], under("guide"))],
    },
    {
      label: "Backends",
      items: orderedPages(pages, backendIndexes, isBackendGuide),
    },
    {
      label: "Reference",
      items: [
        ...existing(pages, [{ slug: "reference", label: "Overview" }]),
        ...orderedPages(pages, [linksOf("docs/reference/README.md")], under("reference")),
        ...existing(pages, [{ slug: "agent-skill", label: "Agent skill" }]),
      ],
    },
    {
      label: "Developing bb-box",
      collapsed: true,
      items: existing(pages, [
        { slug: "architecture", label: "Architecture" },
        { slug: "development", label: "Developing bb-box" },
        { slug: "bb-requests", label: "What bb-box asks of BB" },
      ]),
    },
    {
      label: "Decision records",
      collapsed: true,
      items: [...existing(pages, [{ slug: "decisions", label: "Overview" }]), ...orderedPages(pages, [], under("decisions"), false)],
    },
  ];
  return groups.filter((group) => group.items.length > 0);
}
