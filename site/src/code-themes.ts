import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";

interface Greys {
  background: string;
  text: string;
  emphasis: string;
  literal: string;
  comment: string;
}

const emphasisScopes = ["keyword", "storage", "entity.name.function", "support.function", "entity.name.tag", "entity.name.type", "support.type"];
const literalScopes = ["string", "constant", "markup.inline.raw", "entity.other.attribute-name"];
const commentScopes = ["comment", "punctuation.definition.comment"];

function monochromeTheme(name: string, type: "dark" | "light", greys: Greys): ExpressiveCodeTheme {
  return new ExpressiveCodeTheme({
    name,
    type,
    colors: { "editor.background": greys.background, "editor.foreground": greys.text },
    settings: [
      { settings: { foreground: greys.text } },
      { scope: emphasisScopes, settings: { foreground: greys.emphasis } },
      { scope: literalScopes, settings: { foreground: greys.literal } },
      { scope: commentScopes, settings: { foreground: greys.comment } },
    ],
  });
}

export const codeThemes = [
  monochromeTheme("bb-box-dark", "dark", { background: "#1a1a1a", text: "#e0e0e0", emphasis: "#ffffff", literal: "#ababab", comment: "#8a8a8a" }),
  monochromeTheme("bb-box-light", "light", { background: "#fafafa", text: "#262626", emphasis: "#000000", literal: "#575757", comment: "#737373" }),
];
