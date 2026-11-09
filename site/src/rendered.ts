export interface ListItem {
  title: string;
  html: string;
}

export function listUnder(html: string, headingId: string): ListItem[] {
  const headingAt = html.indexOf(`id="${headingId}"`);
  if (headingAt === -1) return [];
  const list = /<ul>([\s\S]*?)<\/ul>/.exec(html.slice(headingAt));
  if (!list) return [];
  return [...list[1]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((item) => {
    const lead = /^\s*<strong>([\s\S]*?)<\/strong>\s*/.exec(item[1]!);
    return lead ? { title: lead[1]!.replace(/\.$/, ""), html: item[1]!.slice(lead[0].length) } : { title: "", html: item[1]! };
  });
}

export function tableUnder(html: string, headingId: string): string[][] {
  const headingAt = html.indexOf(`id="${headingId}"`);
  if (headingAt === -1) return [];
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html.slice(headingAt));
  if (!body) return [];
  return [...body[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((cell) => cell[1]!.trim()));
}

function topLevelItems(list: string): string[] {
  const items: string[] = [];
  const tag = /<(\/?)(ul|ol|li)\b[^>]*>/g;
  let depth = 0;
  let start = -1;
  for (const match of list.matchAll(tag)) {
    const closing = match[1] === "/";
    const name = match[2];
    if (name === "li" && !closing && depth === 0) start = match.index! + match[0].length;
    if (name === "li" && closing && depth === 0 && start >= 0) {
      items.push(list.slice(start, match.index));
      start = -1;
    }
    if (name !== "li") depth += closing ? -1 : 1;
  }
  return items;
}

function firstList(html: string): string | null {
  const open = /<ul>/.exec(html);
  if (!open) return null;
  const tag = /<(\/?)ul\b[^>]*>/g;
  tag.lastIndex = open.index;
  let depth = 0;
  for (const match of html.matchAll(tag)) {
    if (match.index! < open.index) continue;
    depth += match[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(open.index + open[0].length, match.index);
  }
  return null;
}

export function firstListIn(html: string): ListItem[] {
  const list = firstList(html);
  if (list === null) return [];
  return topLevelItems(list).map((item) => {
    const lead = /^\s*<strong>([\s\S]*?)<\/strong>:?\s*/.exec(item);
    return lead ? { title: lead[1]!, html: item.slice(lead[0].length) } : { title: "", html: item };
  });
}

export const plainText = (html: string) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
