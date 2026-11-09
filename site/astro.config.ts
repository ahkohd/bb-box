import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { codeStyle, codeThemes } from "./src/code-themes.ts";
import { siteHead } from "./src/head.ts";
import { readPages, repoRoot, repository } from "./src/repo.ts";
import { sidebar } from "./src/sidebar.ts";

const site = process.env.SITE_URL;
const base = process.env.SITE_BASE || "/";

export default defineConfig({
  site,
  base,
  integrations: [
    starlight({
      title: "BB Box",
      description: "Computers for BB threads.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg" },
      favicon: "/favicon.png",
      head: siteHead({ site, base }),
      customCss: ["@fontsource-variable/inter", "@fontsource-variable/jetbrains-mono", "./src/styles/theme.css"],
      expressiveCode: { themes: codeThemes, styleOverrides: codeStyle },
      social: [{ icon: "github", label: "GitHub", href: repository }],
      components: { Head: "./src/components/Head.astro", PageTitle: "./src/components/PageTitle.astro", ThemeSelect: "./src/components/ThemeToggle.astro", Footer: "./src/components/Footer.astro" },
      sidebar: sidebar(readPages()),
    }),
  ],
  vite: { server: { fs: { allow: [repoRoot] } } },
});
