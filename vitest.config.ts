// vitest runs only the panel's tests, which need a DOM and JSX. The rest run
// under node --test. "@/" is the vendored components' alias, as in tsconfig.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { include: ["test/**/*.test.tsx"], environment: "jsdom" },
});
