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
  monochromeTheme("bb-box-dark", "dark", { background: "#171717", text: "#e5e5e5", emphasis: "#fafafa", literal: "#a1a1a1", comment: "#a1a1a1" }),
  monochromeTheme("bb-box-light", "light", { background: "#fafafa", text: "#171717", emphasis: "#0a0a0a", literal: "#737373", comment: "#737373" }),
];

const fill = "var(--muted)";

export const codeStyle = {
  borderWidth: "0px",
  borderRadius: "8px",
  codeBackground: fill,
  codeFontSize: "0.8125rem",
  codeLineHeight: "1.5385",
  uiFontSize: "0.75rem",
  uiFontWeight: "400",
  frames: {
    shadowColor: "transparent",
    frameBoxShadowCssValue: "none",
    editorBackground: fill,
    terminalBackground: fill,
    editorTabBarBackground: fill,
    editorActiveTabBackground: fill,
    editorTabBarBorderBottomColor: "transparent",
    editorActiveTabIndicatorTopColor: "transparent",
    editorActiveTabIndicatorBottomColor: "transparent",
    terminalTitlebarBackground: fill,
    terminalTitlebarBorderBottomColor: "transparent",
    terminalTitlebarDotsForeground: "var(--muted-foreground)",
    terminalTitlebarDotsOpacity: "0.4",
    inlineButtonBackground: "var(--foreground)",
    inlineButtonForeground: "var(--foreground)",
    inlineButtonBorder: "transparent",
  },
};
