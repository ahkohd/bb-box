import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { codeStyle, codeThemes } from "./src/code-themes.ts";
import { readPages, repoRoot, repository } from "./src/repo.ts";
import { sidebar } from "./src/sidebar.ts";

export default defineConfig({
  site: process.env.SITE_URL,
  base: process.env.SITE_BASE || "/",
  integrations: [
    starlight({
      title: "BB Box",
      description: "Computers for BB threads.",
      logo: { light: "./src/assets/logo-light.svg", dark: "./src/assets/logo-dark.svg" },
      favicon: "/favicon.svg",
      customCss: ["@fontsource-variable/inter", "./src/styles/theme.css"],
      expressiveCode: { themes: codeThemes, styleOverrides: codeStyle },
      social: [{ icon: "github", label: "GitHub", href: repository }],
      components: { ThemeSelect: "./src/components/ThemeToggle.astro", Footer: "./src/components/Footer.astro" },
      sidebar: sidebar(readPages()),
    }),
  ],
  vite: { server: { fs: { allow: [repoRoot] } } },
});
