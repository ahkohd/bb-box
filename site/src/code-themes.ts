import { ExpressiveCodeTheme } from "@astrojs/starlight/expressive-code";

interface Inks {
  background: string;
  text: string;
  command: string;
  flag: string;
  literal: string;
  comment: string;
}

const commandScopes = ["entity.name.command", "entity.name.function", "support.function", "keyword", "storage", "entity.name.tag", "entity.name.type", "support.type"];
const flagScopes = ["constant.other.option", "variable.parameter", "variable.other", "punctuation.definition.variable"];
const literalScopes = ["string", "constant.numeric", "constant.language", "markup.inline.raw", "entity.other.attribute-name"];
const commentScopes = ["comment", "punctuation.definition.comment", "punctuation.separator.prompt"];

function phosphorTheme(name: string, type: "dark" | "light", inks: Inks): ExpressiveCodeTheme {
  return new ExpressiveCodeTheme({
    name,
    type,
    colors: { "editor.background": inks.background, "editor.foreground": inks.text },
    settings: [
      { settings: { foreground: inks.text } },
      { scope: commandScopes, settings: { foreground: inks.command } },
      { scope: flagScopes, settings: { foreground: inks.flag } },
      { scope: literalScopes, settings: { foreground: inks.literal } },
      { scope: commentScopes, settings: { foreground: inks.comment } },
    ],
  });
}

export const codeThemes = [
  phosphorTheme("bb-box-dark", "dark", { background: "#1c1c1c", text: "#e5e5e5", command: "#ffb224", flag: "#9db0c4", literal: "#e5e5e5", comment: "#a1a1a1" }),
  phosphorTheme("bb-box-light", "light", { background: "#f4f3f0", text: "#171717", command: "#a85000", flag: "#4c6176", literal: "#171717", comment: "#6b6b6b" }),
];

const fill = "var(--muted)";

export const codeStyle = {
  borderWidth: "0px",
  borderRadius: "0px",
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
