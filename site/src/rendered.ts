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
