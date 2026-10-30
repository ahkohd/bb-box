import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { codeThemes } from "./src/code-themes.ts";
import { readPages, repoRoot, repository } from "./src/repo.ts";
import { sidebar } from "./src/sidebar.ts";

export default defineConfig({
  site: process.env.SITE_URL,
  base: process.env.SITE_BASE || "/",
  integrations: [
    starlight({
      title: "bb-box",
      description: "Computers for BB threads.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg" },
      favicon: "/favicon.svg",
      customCss: ["@fontsource-variable/inter/opsz.css", "./src/styles/theme.css"],
      expressiveCode: { themes: codeThemes, useStarlightUiThemeColors: true },
      social: [{ icon: "github", label: "GitHub", href: repository }],
      sidebar: sidebar(readPages()),
    }),
  ],
  vite: { server: { fs: { allow: [repoRoot] } } },
});
