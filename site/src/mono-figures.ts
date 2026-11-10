import type { ElementContent, Text } from "hast";

const figure = /(?<![\w-])(?:x86_64|aarch64|arm64|amd64|\d+(?:[.,:-]\d+)*(?:\s?(?:GiB|GB|MiB|MB|TiB|TB|KiB|KB|cores?|vCPUs?|ms|min|s|h|%))?)(?![\w])/g;
const keepTheirOwnFont = new Set(["code", "pre", "kbd", "samp", "h1", "h2", "h3", "h4", "h5", "h6", "script", "style", "svg", "title"]);

function figureSpans(text: string): ElementContent[] | undefined {
  const pieces: ElementContent[] = [];
  let from = 0;
  for (const match of text.matchAll(figure)) {
    const at = match.index ?? 0;
    if (at > from) pieces.push({ type: "text", value: text.slice(from, at) });
    pieces.push({ type: "element", tagName: "span", properties: { className: ["figure"] }, children: [{ type: "text", value: match[0].replace(/\s+/g, "") }] });
    from = at + match[0].length;
  }
  if (!pieces.length) return undefined;
  if (from < text.length) pieces.push({ type: "text", value: text.slice(from) });
  return pieces;
}

interface Ancestry {
  parent(node: unknown): { type: string; tagName?: string } | undefined;
}

function insideOwnFont(node: unknown, ancestry: Ancestry): boolean {
  for (let above = ancestry.parent(node); above; above = ancestry.parent(above)) {
    if (above.type === "element" && above.tagName && keepTheirOwnFont.has(above.tagName)) return true;
  }
  return false;
}

export const monoFigures = {
  name: "mono-figures",
  text(node: Readonly<Text>, context: Ancestry & { replaceNode(node: unknown, replacement: ElementContent[]): void }): void {
    const pieces = figureSpans(node.value);
    if (!pieces || insideOwnFont(node, context)) return;
    context.replaceNode(node, pieces);
  },
};
